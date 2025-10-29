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

// Bots are now extracted into their own folders in 'bots'
const UPLOAD_PATH = path.join(__dirname, 'uploads');
const BOTS_PATH = path.join(__dirname, 'bots');

// Create folders if they don't exist
[UPLOAD_PATH, BOTS_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// This will store our running bot processes { 'bot_folder_name': process }
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
    // 1. Remove old folder if it exists (for upgrades)
    if (fs.existsSync(extractPath)) {
      await fs.promises.rm(extractPath, { recursive: true, force: true });
    }
    // 2. Create new folder
    await fs.promises.mkdir(extractPath, { recursive: true });
    // 3. Extract zip
    await extract(zipPath, { dir: extractPath });
    // 4. Delete the uploaded zip file
    await fs.promises.unlink(zipPath);
    
    io.emit('log', `--- ${botName} uploaded and extracted successfully. ---`);
    io.emit('status_update'); // Tell browser to refresh bot list
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
    } catch (e) {
      console.error('Invalid package.json:', e.message);
    }
  }
  // Fallback to common names
  if (fs.existsSync(path.join(botPath, 'index.js'))) return 'index.js';
  if (fs.existsSync(path.join(botPath, 'bot.js'))) return 'bot.js';
  return null; // Can't find it
};

// Start
app.get('/api/start/:botname', (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) return res.status(400).send('Bot is already running.');

  const botPath = path.join(BOTS_PATH, botname);
  const mainScript = getMainScript(botPath);

  if (!mainScript) {
    sendLog(io, botname, 'ERROR: Cannot find main script (index.js, bot.js, or "main" in package.json).');
    return res.status(404).send('Bot main script not found.');
  }
  
  const mainScriptPath = path.join(botPath, mainScript);
  if (!fs.existsSync(mainScriptPath)) {
     sendLog(io, botname, `ERROR: Main script "${mainScript}" not found in bot folder.`);
     return res.status(404).send('Bot main script file not found.');
  }

  // Run 'node' from *within* the bot's directory
  const botProcess = spawn('node', [mainScript], { cwd: botPath });
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
      }, 1000); // 1 sec delay
    });
    runningBots[botname].kill();
  } else {
    app.get('/api/start/:botname', () => {})(req, res); // Just start it
  }
});

// NEW: Install Dependencies
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
  
  // Run 'npm install' from within the bot's directory
  const installProcess = spawn('npm', ['install'], { cwd: botPath });

  installProcess.stdout.on('data', (data) => sendLog(io, botname, data));
  installProcess.stderr.on('data', (data) => sendLog(io, botname, `NPM_ERROR: ${data}`));

  installProcess.on('close', (code) => {
    if (code === 0) {
      sendLog(io, botname, '--- "npm install" completed successfully. ---');
    } else {
      sendLog(io, botname, `--- "npm install" failed with code ${code}. ---`);
    }
    io.emit('status_update');
  });
  res.send('Install process started.');
});

// NEW: Delete Bot
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


// --- 10. Start Server and Log Sockets ---
io.on('connection', (socket) => {
  console.log('Panel user connected');
  socket.emit('log', 'Welcome to your Bot Panel! Upload a .zip file to begin.');
});

server.listen(port, () => {
  console.log(`Bot Panel is running at http://localhost:${port}`);
  console.log('Login with user: admin, pass: your-new-password-123');
});
