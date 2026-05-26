const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = 'supersecret123';

function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

function login(username, password, db) {
  const user = db.find((u) => u.username === username);
  if (!user) return null;

  const hashed = hashPassword(password);
  if (user.password !== hashed) return null;

  const token = jwt.sign({ userId: user.id, username }, SECRET);
  return token;
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function createUser(username, password, db) {
  const existing = db.find((u) => u.username === username);
  if (existing) throw new Error('User already exists');

  const user = {
    id: db.length + 1,
    username,
    password: hashPassword(password),
  };
  db.push(user);
  return user;
}

module.exports = { login, verifyToken, createUser, hashPassword };
