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

const UPLOAD_PATH = path.join(__dirname, 'uploads');
const BOTS_PATH = path.join(__dirname, 'bots');

// --- NEW: Use express.json() to read JSON from browser ---
app.use(express.json());

[UPLOAD_PATH, BOTS_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

let runningBots = {};

// --- 3. Security (Password Protection) ---
// !!! CHANGE THIS PASSWORD !!!
app.use(basicAuth({
  users: { 'admin': 'your-new-password-123' },
  challenge: true,
  realm: 'MyBotPanel',
}));

// --- 4. File Upload Setup (ZIP only) ---
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

// --- 5. Helper Function to send logs to browser ---
const sendLog = (socket, botname, message) => {
  const formattedMessage = `[${botname}]: ${message.toString()}`;
  console.log(formattedMessage);
  socket.emit('log', formattedMessage);
};

// --- 6. Main Panel Page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 7. API to List Bots ---
app.get('/api/bots', (req, res) => {
  fs.readdir(BOTS_PATH, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).send('Error reading bots folder');
    
    const bots = entries
      .filter(entry => entry.isDirectory())
      .map(dir => ({
        name: dir.name,
        status: runningBots[dir.name] ? 'Running' : 'Stopped'
      }));
    res.json(bots);
  });
});

// --- 8. API to Upload a Bot (.zip) ---
app.post('/api/upload', upload.single('botfile'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const zipPath = req.file.path;
  const botName = path.basename(req.file.filename, '.zip');
  const extractPath = path.join(BOTS_PATH, botName);

  try {
    if (fs.existsSync(extractPath)) {
      await fs.promises.rm(extractPath, { recursive: true, force: true });
    }
    await fs.promises.mkdir(extractPath, { recursive: true });
    await extract(zipPath, { dir: extractPath });
    await fs.promises.unlink(zipPath);

    const files = await fs.promises.readdir(extractPath);
    if (files.length === 1) {
      const nestedPath = path.join(extractPath, files[0]);
      const stats = await fs.promises.stat(nestedPath);
      
      if (stats.isDirectory()) {
        sendLog(io, botName, '--- Nested directory detected. Promoting contents... ---');
        const nestedFiles = await fs.promises.readdir(nestedPath);
        for (const file of nestedFiles) {
          await fs.promises.rename(path.join(nestedPath, file), path.join(extractPath, file));
        }
        await fs.promises.rmdir(nestedPath);
        sendLog(io, botName, '--- Contents promoted successfully. ---');
      }
    }
    
    io.emit('log', `--- ${botName} uploaded and extracted successfully. ---`);
    io.emit('status_update');
    res.redirect('/');
  } catch (err) {
    console.error(err);
    io.emit('log', `--- Error uploading ${botName}: ${err.message} ---`);
    res.status(500).send('Error processing upload.');
  }
});

// --- 9. API to Manage Bots (Start, Stop, etc.) ---

// Helper function to find the main script
const getMainScript = (botPath) => {
  const packageJsonPath = path.join(botPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg.main) return pkg.main;
    } catch (e) { console.error('Invalid package.json:', e.message); }
  }
  if (fs.existsSync(path.join(botPath, 'index.js'))) return 'index.js';
  if (fs.existsSync(path.join(botPath, 'bot.js'))) return 'bot.js';
  return null;
};

// --- NEW HELPER: Get environment variables for a bot ---
const getBotEnv = async (botPath) => {
  // 1. Clone the panel's own environment
  const baseEnv = { ...process.env };
  
  // 2. Define the path for the bot's custom env file
  const envPath = path.join(botPath, '.env.json');
  
  // 3. If the file exists, read it, parse it, and merge it
  if (fs.existsSync(envPath)) {
    try {
      const envFile = await fs.promises.readFile(envPath, 'utf8');
      const botEnv = JSON.parse(envFile);
      // Merge: The bot's custom env (botEnv) overwrites the base env
      return { ...baseEnv, ...botEnv };
    } catch (e) {
      console.error(`Invalid .env.json for ${botPath}: ${e.message}`);
      return baseEnv; // Return base env on error
    }
  }
  // 4. If no file, just return the base env
  return baseEnv;
};

// Start
app.get('/api/start/:botname', async (req, res) => { // Now async
  const botname = req.params.botname;
  if (runningBots[botname]) return res.status(400).send('Bot is already running.');

  const botPath = path.join(BOTS_PATH, botname);
  const mainScript = getMainScript(botPath);

  if (!mainScript) {
    const errorMsg = 'ERROR: Cannot find main script (index.js, bot.js, or "main" in package.json).';
    sendLog(io, botname, errorMsg);
    return res.status(404).send('Bot main script not found.');
  }
  
  const mainScriptPath = path.join(botPath, mainScript);
  if (!fs.existsSync(mainScriptPath)) {
     const errorMsg = `ERROR: Main script "${mainScript}" not found.`;
     sendLog(io, botname, errorMsg);
     return res.status(404).send('Bot main script file not found.');
  }

  // --- UPGRADED: Get the merged env variables ---
  const botEnv = await getBotEnv(botPath);

  // --- UPGRADED: Pass the 'env' object to spawn ---
  const botProcess = spawn('node', [mainScript], { 
    cwd: botPath, 
    env: botEnv // This injects your keys!
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
      setTimeout(() => {
        app.get('/api/start/:botname', () => {})(req, res);
      }, 1000);
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

  if (!fs.existsSync(path.join(botPath, 'package.json'))) {
    sendLog(io, botname, 'No package.json found. Skipping install.');
    return res.status(400).send('No package.json found.');
  }
  if (runningBots[botname]) {
    sendLog(io, botname, 'Please stop the bot before installing dependencies.');
    return res.status(400).send('Bot is running. Please stop it first.');
  }

  sendLog(io, botname, '--- Running "npm install"... This may take a moment. ---');
  const installProcess = spawn('npm', ['install'], { cwd: botPath });

  installProcess.stdout.on('data', (data) => sendLog(io, botname, data));
  installProcess.stderr.on('data', (data) => sendLog(io, botname, `NPM_ERROR: ${data}`));
  installProcess.on('close', (code) => {
    sendLog(io, botname, code === 0 ? '--- "npm install" completed successfully. ---' : `--- "npm install" failed with code ${code}. ---`);
    io.emit('status_update');
  });
  res.send('Install process started.');
});

// Delete Bot
app.get('/api/delete/:botname', async (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) {
    return res.status(400).send('Bot is running. Please stop it first.');
  }
  const botPath = path.join(BOTS_PATH, botname);
  if (!fs.existsSync(botPath)) {
    return res.status(404).send('Bot not found.');
  }
  try {
    await fs.promises.rm(botPath, { recursive: true, force: true });
    sendLog(io, botname, '--- Bot project deleted successfully. ---');
    io.emit('status_update');
    res.send('Bot deleted');
  } catch (err) {
    sendLog(io, botname, `--- Error deleting bot: ${err.message} ---`);
    res.status(500).send('Error deleting bot.');
  }
});


// --- 10. NEW API: Get/Set Environment Variables ---

// Get Env Vars
app.get('/api/env/:botname', async (req, res) => {
  const botname = req.params.botname;
  const envPath = path.join(BOTS_PATH, botname, '.env.json');
  
  if (fs.existsSync(envPath)) {
    // Send existing file
    res.sendFile(envPath);
  } else {
    // Send an empty object so the modal isn't blank
    res.json({});
  }
});

// Save Env Vars
app.post('/api/env/:botname', async (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) {
    return res.status(400).send('Bot is running. Please stop it first.');
  }
  
  const envPath = path.join(BOTS_PATH, botname, '.env.json');
  
  try {
    // Write the JSON, formatted nicely (null, 2)
    await fs.promises.writeFile(envPath, JSON.stringify(req.body, null, 2));
    sendLog(io, botname, '--- Environment variables saved successfully. ---');
    res.send('Env saved');
  } catch (err) {
    sendLog(io, botname, `--- Error saving env: ${err.message} ---`);
    res.status(500).send('Error saving env file.');
  }
});


// --- 11. Start Server and Log Sockets ---
io.on('connection', (socket) => {
  console.log('Panel user connected');
  socket.emit('log', 'Welcome to your Bot Panel! Upload a .zip file to begin.');
});

server.listen(port, () => {
  console.log(`Bot Panel is running at http://localhost:${port}`);
  console.log('Login with user: admin, pass: your-new-password-123');
});
