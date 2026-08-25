'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_PROVIDER_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

function providerError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function normalizeCommand(value) {
  const command = String(value || '').trim();
  if (!command) return '';
  if (!path.isAbsolute(command)) throw providerError('asvs-crypto-command-not-absolute');
  const linkStat = fs.lstatSync(command);
  if (linkStat.isSymbolicLink()) throw providerError('asvs-crypto-command-symlink-forbidden');
  const stat = fs.statSync(command);
  if (!stat.isFile()) throw providerError('asvs-crypto-command-not-file');
  if (process.platform !== 'win32' && (stat.mode & 0o022)) throw providerError('asvs-crypto-command-writable-by-group-or-world');
  return command;
}

function createExternalCryptoProvider(options = {}) {
  const command = normalizeCommand(options.command || process.env.ASVS_L3_CRYPTO_COMMAND);
  if (!command) return null;
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  // JavaScript providers are launched explicitly through the current Node
  // runtime. POSIX can execute a shebang script directly, but Windows
  // CreateProcess/execFile cannot execute a .js file and returns EFTYPE.
  // Using process.execPath on every platform keeps the provider contract
  // identical in CI, Windows portable/installer builds and Linux containers.
  const javascriptProvider = /\.(?:cjs|mjs|js)$/i.test(command);
  const executable = javascriptProvider ? process.execPath : command;
  const executableArgs = javascriptProvider ? [command] : [];

  function call(op, payload = {}) {
    const request = JSON.stringify({ version:1, op:String(op || ''), ...payload });
    let stdout;
    try {
      stdout = execFileSync(executable, executableArgs, {
        input:request,
        encoding:'utf8',
        timeout:timeoutMs,
        maxBuffer:MAX_PROVIDER_OUTPUT,
        windowsHide:true,
        shell:false,
        // Do not pass Direct-Xfer application secrets to the provider process.
        // Provider authentication should come from its own workload identity,
        // agent socket, HSM or service configuration.
        env:{
          PATH:process.env.PATH || '',
          HOME:process.env.HOME || '',
          USERPROFILE:process.env.USERPROFILE || '',
          SystemRoot:process.env.SystemRoot || '',
          WINDIR:process.env.WINDIR || '',
          DX_CRYPTO_AGENT_SOCKET:process.env.DX_CRYPTO_AGENT_SOCKET || '',
          DX_CRYPTO_AGENT_CONFIG:process.env.DX_CRYPTO_AGENT_CONFIG || '',
        },
      });
    } catch (error) {
      throw providerError('asvs-crypto-provider-failed', String(error && error.message || error).slice(0,300));
    }
    let response;
    try { response = JSON.parse(String(stdout || '')); }
    catch (_) { throw providerError('asvs-crypto-provider-invalid-json'); }
    if (!response || response.ok !== true) throw providerError('asvs-crypto-provider-rejected', String(response && response.error || 'provider rejected operation'));
    return response;
  }

  const selfTest = call('self-test', { profile:'direct-xfer-asvs-l3-v1' });
  const operations = new Set(Array.isArray(selfTest.operations) ? selfTest.operations.map(String) : []);
  for (const required of ['encrypt','decrypt','hmac','sign']) {
    if (!operations.has(required)) throw providerError('asvs-crypto-provider-operation-missing', required);
  }
  if (selfTest.keyIsolation !== true || selfTest.keyExportable !== false || selfTest.hardwareBacked !== true || selfTest.allSecretKeyOperationsIsolated !== true) {
    throw providerError('asvs-crypto-provider-not-isolated');
  }
  const signingPublicKey = String(selfTest.signingPublicKey || '').trim();
  if (!signingPublicKey.includes('BEGIN PUBLIC KEY')) throw providerError('asvs-crypto-provider-signing-public-key-missing');
  const keyIds = selfTest.keyIds && typeof selfTest.keyIds === 'object' ? selfTest.keyIds : {};
  for (const key of ['data','audit-hmac','audit-signing','runtime-hmac']) {
    if (!String(keyIds[key] || '').trim()) throw providerError('asvs-crypto-provider-key-id-missing', key);
  }

  return Object.freeze({
    command,
    selfTest:Object.freeze({ ...selfTest, operations:Object.freeze([...operations]), keyIds:Object.freeze({ ...keyIds }) }),
    keyId(name) { return String(keyIds[name] || ''); },
    encrypt(plaintext, context = 'state') {
      const response = call('encrypt', { key:'data', context, plaintext:Buffer.from(String(plaintext), 'utf8').toString('base64') });
      if (typeof response.ciphertext !== 'string' || !response.ciphertext) throw providerError('asvs-crypto-provider-ciphertext-missing');
      return { ciphertext:response.ciphertext, keyId:String(response.keyId || keyIds.data) };
    },
    decrypt(ciphertext, context = 'state', keyId = '') {
      const response = call('decrypt', { key:'data', keyId:String(keyId || keyIds.data), context, ciphertext:String(ciphertext || '') });
      if (typeof response.plaintext !== 'string') throw providerError('asvs-crypto-provider-plaintext-missing');
      return Buffer.from(response.plaintext, 'base64').toString('utf8');
    },
    hmac(input, key = 'audit-hmac') {
      const keyName = String(key || 'audit-hmac');
      if (!['audit-hmac','runtime-hmac'].includes(keyName)) throw providerError('asvs-crypto-provider-hmac-key-invalid');
      const response = call('hmac', { key:keyName, input:Buffer.from(String(input), 'utf8').toString('base64') });
      const digest = String(response.digest || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(digest)) throw providerError('asvs-crypto-provider-hmac-invalid');
      return digest;
    },
    sign(input) {
      const response = call('sign', { key:'audit-signing', input:Buffer.from(input).toString('base64') });
      const signature = String(response.signature || '');
      if (!signature || Buffer.from(signature, 'base64').length < 32) throw providerError('asvs-crypto-provider-signature-invalid');
      return Buffer.from(signature, 'base64');
    },
    signingPublicKey,
  });
}

module.exports = { createExternalCryptoProvider, normalizeCommand };
