// --- 1. Imports ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const basicAuth = require('express-basic-auth');
const extract = require('extract-zip');

// --- 2. Basic Config ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

// Middleware for parsing form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 3. Paths and Database ---
const UPLOAD_PATH = path.join(__dirname, 'uploads');
const BOTS_PATH = path.join(__dirname, 'bots');
const DB_PATH = path.join(__dirname, 'bots.json');

// Create folders/files if they don't exist
[UPLOAD_PATH, BOTS_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ bots: {} }));
}

// This will store our running bot processes { 'bot_name': process }
let runningBots = {};

// --- 4. Database Helper Functions ---
const readDb = () => {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH));
  } catch (e) {
    console.error('Error reading DB, resetting...', e);
    fs.writeFileSync(DB_PATH, JSON.stringify({ bots: {} }));
    return { bots: {} };
  }
};

const writeDb = (data) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
};

// --- 5. Security (Password Protection) ---
// !!! CHANGE THIS PASSWORD !!!
app.use(basicAuth({
  users: { 'admin': 'your-pro-password-123' },
  challenge: true,
  realm: 'MyBotPanel',
}));

// --- 6. File Upload Setup (ZIP only) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage, fileFilter: (req, file, cb) => {
  if (path.extname(file.originalname) !== '.zip') {
    return cb(new Error('Only .zip files are allowed'), false);
  }
  cb(null, true);
}});

// --- 7. Helper Function to send logs to browser ---
const sendLog = (socket, botname, message) => {
  const formattedMessage = `[${botname}]: ${message.toString()}`;
  console.log(formattedMessage);
  socket.emit('log', formattedMessage);
};

// --- 8. Main Panel Page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 9. API to List Bots (Now reads from DB) ---
app.get('/api/bots', (req, res) => {
  const db = readDb();
  const bots = Object.keys(db.bots).map(botName => ({
    name: botName,
    status: runningBots[botName] ? 'Running' : 'Stopped'
  }));
  res.json(bots);
});

// --- 10. API to Upload a Bot (.zip) ---
app.post('/api/upload', upload.single('botfile'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const zipPath = req.file.path;
  const botName = path.basename(req.file.filename, '.zip');
  const extractPath = path.join(BOTS_PATH, botName);

  try {
    // 1. Stop bot if it's running
    if (runningBots[botName]) {
      runningBots[botName].kill();
      delete runningBots[botName];
      sendLog(io, botName, '--- Bot stopped for upgrade... ---');
    }
    // 2. Remove old folder if it exists
    if (fs.existsSync(extractPath)) {
      await fs.promises.rm(extractPath, { recursive: true, force: true });
    }
    // 3. Create new folder and extract
    await fs.promises.mkdir(extractPath, { recursive: true });
    await extract(zipPath, { dir: extractPath });
    await fs.promises.unlink(zipPath); // Delete zip

    // --- Auto-fix nested directories ---
    const files = await fs.promises.readdir(extractPath);
    if (files.length === 1) {
      const nestedPath = path.join(extractPath, files[0]);
      if ((await fs.promises.stat(nestedPath)).isDirectory()) {
        sendLog(io, botName, '--- Nested directory detected. Promoting contents... ---');
        const nestedFiles = await fs.promises.readdir(nestedPath);
        for (const file of nestedFiles) {
          await fs.promises.rename(path.join(nestedPath, file), path.join(extractPath, file));
        }
        await fs.promises.rmdir(nestedPath);
      }
    }
    
    // --- Add to DB ---
    const db = readDb();
    if (!db.bots[botName]) {
      db.bots[botName] = { env: {} };
    }
    writeDb(db);
    
    sendLog(io, botName, `--- ${botName} uploaded/upgraded successfully. ---`);
    io.emit('status_update');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    sendLog(io, botName, `--- Error uploading ${botName}: ${err.message} ---`);
    res.status(500).send('Error processing upload.');
  }
});

// --- 11. API to Manage Bots (Start, Stop, etc.) ---

const getMainScript = (botPath) => {
  const packageJsonPath = path.join(botPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.main) return pkg.main;
    } catch (e) { /* ignore */ }
  }
  if (fs.existsSync(path.join(botPath, 'index.js'))) return 'index.js';
  if (fs.existsSync(path.join(botPath, 'bot.js'))) return 'bot.js';
  return null;
};

// Start
app.get('/api/start/:botname', (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) return res.status(400).send('Bot is already running.');

  const botPath = path.join(BOTS_PATH, botname);
  const mainScript = getMainScript(botPath);

  if (!mainScript) {
    return res.status(404).send('Bot main script not found.');
  }
  
  // --- Load Env Vars from DB ---
  const db = readDb();
  const botEnv = db.bots[botname] ? db.bots[botname].env : {};

  // Combine with process.env so bot can see PATH, etc.
  const env = { ...process.env, ...botEnv };

  // Run 'node' from *within* the bot's directory
  const botProcess = spawn('node', [mainScript], { 
    cwd: botPath,
    env: env // <-- Pass the environment variables
  });
  runningBots[botname] = botProcess;

  botProcess.stdout.on('data', (data) => sendLog(io, botname, data));
  botProcess.stderr.on('data', (data) => sendLog(io, botname, `ERROR: ${data}`));

  botProcess.on('close', (code) => {
    sendLog(io, botname, `--- stopped with code ${code} ---`);
    delete runningBots[botname];
    io.emit('status_update');
  });

  sendLog(io, botname, `--- starting... ---`);
  io.emit('status_update');
  res.send('Bot started');
});

// Stop
app.get('/api/stop/:botname', (req, res) => {
  const botname = req.params.botname;
  if (!runningBots[botname]) return res.status(400).send('Bot is not running.');
  runningBots[botname].kill();
  sendLog(io, botname, `--- stopping... ---`);
  res.send('Bot stopping');
});

// Restart
app.get('/api/restart/:botname', (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) {
    runningBots[botname].once('close', () => {
      setTimeout(() => app.get('/api/start/:botname', () => {})(req, res), 1000);
    });
    runningBots[botname].kill();
  } else {
    app.get('/api/start/:botname', () => {})(req, res);
  }
});

// Install Dependencies
app.get('/api/install/:botname', (req, res) => {
  const botname = req.params.botname;
  const botPath = path.join(BOTS_PATH, botname);
  if (runningBots[botname]) return res.status(400).send('Bot is running. Stop it first.');
  if (!fs.existsSync(path.join(botPath, 'package.json'))) {
    return res.status(400).send('No package.json found.');
  }

  sendLog(io, botname, '--- Running "npm install"... ---');
  const installProcess = spawn('npm', ['install'], { cwd: botPath });
  installProcess.stdout.on('data', (data) => sendLog(io, botname, data));
  installProcess.stderr.on('data', (data) => sendLog(io, botname, `NPM_ERROR: ${data}`));
  installProcess.on('close', (code) => {
    sendLog(io, botname, `--- "npm install" finished (code ${code}) ---`);
  });
  res.send('Install process started.');
});

// Delete Bot
app.get('/api/delete/:botname', async (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) return res.status(400).send('Bot is running. Stop it first.');
  
  const botPath = path.join(BOTS_PATH, botname);
  const db = readDb();
  
  try {
    if (fs.existsSync(botPath)) {
      await fs.promises.rm(botPath, { recursive: true, force: true });
    }
    if (db.bots[botname]) {
      delete db.bots[botname];
      writeDb(db);
    }
    sendLog(io, botname, '--- Bot project deleted successfully. ---');
    io.emit('status_update');
    res.send('Bot deleted');
  } catch (err) {
    sendLog(io, botname, `--- Error deleting bot: ${err.message} ---`);
    res.status(500).send('Error deleting bot.');
  }
});

// --- 12. NEW: Environment Variable APIs ---
app.get('/api/env/:botname', (req, res) => {
  const botname = req.params.botname;
  const db = readDb();
  if (!db.bots[botname]) {
    return res.status(404).send('Bot not found');
  }
  res.json(db.bots[botname].env || {});
});

app.post('/api/env/:botname', (req, res) => {
  const botname = req.params.botname;
  const { key, value } = req.body;
  
  if (!key || value === undefined) {
    return res.status(400).send('Key and Value are required.');
  }

  const db = readDb();
  if (!db.bots[botname]) {
    return res.status(404).send('Bot not found');
  }
  
  db.bots[botname].env[key] = value;
  writeDb(db);
  
  sendLog(io, botname, `--- Env variable [${key}] added/updated. ---`);
  res.send('Variable saved.');
});

app.post('/api/env/delete/:botname', (req, res) => {
  const botname = req.params.botname;
  const { key } = req.body;

  if (!key) return res.status(400).send('Key is required.');

  const db = readDb();
  if (!db.bots[botname] || !db.bots[botname].env[key]) {
    return res.status(404).send('Variable not found.');
  }
  
  delete db.bots[botname].env[key];
  writeDb(db);
  
  sendLog(io, botname, `--- Env variable [${key}] deleted. ---`);
  res.send('Variable deleted.');
});


// --- 13. Start Server ---
io.on('connection', (socket) => {
  console.log('Panel user connected');
  socket.emit('log', 'Welcome to your PRO Bot Panel!');
});

server.listen(port, () => {
  console.log(`Bot Panel is running at http://localhost:${port}`);
  console.log('Login with user: admin, pass: your-pro-password-123');
});
