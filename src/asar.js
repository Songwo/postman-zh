'use strict';
// 极简 asar 读写实现（无第三方依赖），可在 Postman 自带的 Electron（ELECTRON_RUN_AS_NODE=1）里运行。
// asar 格式：[8 字节 size pickle][header pickle(JSON)][数据区]，header 中的 offset 相对数据区起点。

const fs = require('fs');
const crypto = require('crypto');

const BLOCK_SIZE = 4 * 1024 * 1024;
const COPY_CHUNK = 8 * 1024 * 1024;

function withNoAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prev;
  }
}

function readHeader(file) {
  return withNoAsar(() => {
    const fd = fs.openSync(file, 'r');
    try {
      const sizeBuf = Buffer.alloc(8);
      fs.readSync(fd, sizeBuf, 0, 8, 0);
      const headerPickleSize = sizeBuf.readUInt32LE(4);
      const hp = Buffer.alloc(headerPickleSize);
      fs.readSync(fd, hp, 0, headerPickleSize, 8);
      const strLen = hp.readUInt32LE(4);
      const header = JSON.parse(hp.toString('utf8', 8, 8 + strLen));
      return { header, dataOffset: 8 + headerPickleSize, fileSize: fs.fstatSync(fd).size };
    } finally {
      fs.closeSync(fd);
    }
  });
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const payload = (4 + json.length + 3) & ~3;
  const hp = Buffer.alloc(4 + payload);
  hp.writeUInt32LE(payload, 0);
  hp.writeUInt32LE(json.length, 4);
  json.copy(hp, 8);
  const sp = Buffer.alloc(8);
  sp.writeUInt32LE(4, 0);
  sp.writeUInt32LE(hp.length, 4);
  return Buffer.concat([sp, hp]);
}

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + BLOCK_SIZE)).digest('hex'));
  }
  if (!blocks.length) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function splitPath(p) {
  return p.split(/[\\/]+/).filter(Boolean);
}

function getEntry(header, p) {
  let node = header;
  for (const seg of splitPath(p)) {
    if (!node.files || !Object.prototype.hasOwnProperty.call(node.files, seg)) return null;
    node = node.files[seg];
  }
  return node;
}

function setEntry(header, p, entry) {
  const segs = splitPath(p);
  let node = header;
  for (const seg of segs.slice(0, -1)) {
    node.files[seg] = node.files[seg] || { files: {} };
    node = node.files[seg];
  }
  node.files[segs[segs.length - 1]] = entry;
}

function readEntry(file, info, entry) {
  if (!entry || entry.files || entry.unpacked || entry.link) throw new Error('不是可读取的打包文件');
  return withNoAsar(() => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(entry.size);
      fs.readSync(fd, buf, 0, entry.size, info.dataOffset + Number(entry.offset));
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  });
}

// 把 src 的前 keepDataLen 字节数据区原样复制，再追加 appends，生成新的 asar 写到 out。
function writeArchive(src, info, header, keepDataLen, appends, out) {
  withNoAsar(() => {
    const inFd = fs.openSync(src, 'r');
    const outFd = fs.openSync(out, 'w');
    try {
      const head = encodeHeader(header);
      fs.writeSync(outFd, head, 0, head.length);
      const chunk = Buffer.alloc(COPY_CHUNK);
      let copied = 0;
      while (copied < keepDataLen) {
        const n = fs.readSync(inFd, chunk, 0, Math.min(COPY_CHUNK, keepDataLen - copied), info.dataOffset + copied);
        if (n <= 0) throw new Error('读取 asar 数据区失败');
        fs.writeSync(outFd, chunk, 0, n);
        copied += n;
      }
      for (const buf of appends) fs.writeSync(outFd, buf, 0, buf.length);
    } finally {
      fs.closeSync(inFd);
      fs.closeSync(outFd);
    }
  });
}

module.exports = { withNoAsar, readHeader, encodeHeader, integrity, getEntry, setEntry, readEntry, writeArchive };
