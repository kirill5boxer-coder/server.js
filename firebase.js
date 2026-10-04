/* ==========================================
   FIREBASE ADMIN INIT (без Storage)
========================================== */
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const serviceAccount = require(path.join(__dirname, 'serviceAccount.json'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const auth = admin.auth();

console.log('✅ Firebase инициализирован');
console.log('   Project:', serviceAccount.project_id);
console.log('   Database:', process.env.FIREBASE_DATABASE_URL);

module.exports = { admin, db, auth };