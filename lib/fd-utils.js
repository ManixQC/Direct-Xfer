'use strict';

const fs = require('fs');

// Promise wrappers around the callback-based descriptor API.  Unlike
// fs.promises.open(), fs.open() returns a plain numeric descriptor rather than a
// FileHandle object.  Keeping ownership explicit here prevents Node from ever
// having to close a forgotten FileHandle during garbage collection (DEP0137).
function openFd(filePath, flags, mode) {
  return new Promise((resolve, reject) => {
    const done = (error, fd) => error ? reject(error) : resolve(fd);
    if (mode === undefined) fs.open(filePath, flags, done);
    else fs.open(filePath, flags, mode, done);
  });
}

function closeFd(fd) {
  if (!Number.isInteger(fd) || fd < 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    fs.close(fd, (error) => error ? reject(error) : resolve());
  });
}

function statFd(fd) {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (error, stat) => error ? reject(error) : resolve(stat));
  });
}

function readFd(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (error, bytesRead, outBuffer) => {
      if (error) reject(error);
      else resolve({ bytesRead, buffer: outBuffer });
    });
  });
}

module.exports = { openFd, closeFd, statFd, readFd };
