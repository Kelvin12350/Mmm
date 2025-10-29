// --- 1. Imports ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const basicAuth = require('express-basic-auth');

// --- 2. Basic Config ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;
const UPLOAD_PATH = path.join(__dirname, 'uploads');

// This will store our running bot processes { 'filename.js': process }
let runningBots = {};

// --- 3. Security (Password Protection) ---
// CHANGE THIS PASSWORD!
app.use(basicAuth({
  users: { 'admin': 'change_this_password' },
  challenge: true,
  realm: 'MyBotPanel',
}));

// --- 4. File Upload Setup ---
if (!fs.existsSync(UPLOAD_PATH)) {
  fs.mkdirSync(UPLOAD_PATH);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_PATH);
  },
  filename: (req, file, cb) => {
    // Allow overwriting existing bot
    cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

// --- 5. Main Panel Page ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 6. API to List Bots ---
app.get('/api/bots', (req, res) => {
  fs.readdir(UPLOAD_PATH, (err, files) => {
    if (err) {
      return res.status(500).send('Error reading uploads folder');
    }
    const bots = files
      .filter(file => file.endsWith('.js'))
      .map(file => ({
        name: file,
        status: runningBots[file] ? 'Running' : 'Stopped'
      }));
    res.json(bots);
  });
});

// --- 7. API to Upload a Bot ---
app.post('/api/upload', upload.single('botfile'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  console.log(`File uploaded: ${req.file.filename}`);
  res.redirect('/');
});

// --- 8. API to Manage Bots (Start, Stop, Restart) ---
app.get('/api/start/:botname', (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) {
    return res.status(400).send('Bot is already running.');
  }

  const botPath = path.join(UPLOAD_PATH, botname);
  if (!fs.existsSync(botPath)) {
    return res.status(404).send('Bot file not found.');
  }

  // Use spawn to run 'node' with the bot file
  const botProcess = spawn('node', [botPath]);
  runningBots[botname] = botProcess;

  // Function to send logs to the browser
  const sendLog = (data) => {
    // Emit a 'log' event to all connected web browsers
    io.emit('log', `[${botname}]: ${data.toString()}`);
  };

  // Listen for logs and errors
  botProcess.stdout.on('data', sendLog);
  botProcess.stderr.on('data', sendLog);

  // When the bot stops (crashes or finishes)
  botProcess.on('close', (code) => {
    io.emit('log', `--- ${botname} stopped with code ${code} ---`);
    delete runningBots[botname];
    io.emit('status_update'); // Tell browser to refresh bot list
  });

  io.emit('log', `--- ${botname} started ---`);
  io.emit('status_update');
  res.send('Bot started');
});

app.get('/api/stop/:botname', (req, res) => {
  const botname = req.params.botname;
  if (!runningBots[botname]) {
    return res.status(400).send('Bot is not running.');
  }

  // Send the 'kill' signal to stop the process
  runningBots[botname].kill();
  io.emit('log', `--- ${botname} stopping... ---`);
  // The 'close' event listener above will handle the cleanup
  res.send('Bot stopping');
});

app.get('/api/restart/:botname', (req, res) => {
  const botname = req.params.botname;
  if (runningBots[botname]) {
    runningBots[botname].kill();
    // We'll restart it inside the 'close' event handler for a clean restart
    runningBots[botname].once('close', () => {
      // Need a small delay to let resources free up
      setTimeout(() => {
        app.get('/api/start/:botname', () => {})(req, res);
      }, 1000);
    });
  } else {
    // If not running, just start it
    app.get('/api/start/:botname', () => {})(req, res);
  }
});


// --- 9. Start Server and Log Sockets ---
io.on('connection', (socket) => {
  console.log('Panel user connected');
  socket.emit('log', 'Welcome to your Bot Panel!');
});

server.listen(port, () => {
  console.log(`Bot Panel is running at http://localhost:${port}`);
  console.log('Login with user: admin, pass: change_this_password');
});
