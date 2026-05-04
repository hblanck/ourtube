'use strict';

const { initDb } = require('./db');
const { generateAdminKey, createAdminKeyRecord } = require('./admin-auth');

function printHelp() {
  console.log('Usage: node src/admin-key-cli.js create [name]');
  console.log('');
  console.log('Creates a new admin key and prints it once.');
  console.log('Store it securely; the plain key is not recoverable later.');
}

function run() {
  const command = String(process.argv[2] || '').trim().toLowerCase();
  const nameArg = String(process.argv.slice(3).join(' ') || '').trim();
  const name = nameArg || 'Bootstrap Key';

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command !== 'create') {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  initDb();

  const key = generateAdminKey();
  const id = createAdminKeyRecord(name, key);

  console.log('Admin key created successfully.');
  console.log(`ID: ${id}`);
  console.log(`Name: ${name}`);
  console.log(`Key: ${key}`);
  console.log('');
  console.log('Use this key in the UI to enable admin mode.');
}

run();
