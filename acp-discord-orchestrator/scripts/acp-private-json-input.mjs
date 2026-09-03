import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys(value, required, optional, fail, code) {
  if (!hasExactKeys(value, required, optional)) fail(code);
}

export function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    !keys.some((key) => !allowed.has(key));
}

export function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : fallback;
}

export function isCliEntry(argvPath, moduleUrl, fileSystem = fs) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return fileSystem.realpathSync(path.resolve(argvPath)) ===
      fileSystem.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function parsePrivateJsonInputCli(argv, fail) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    fail("usage");
  }
  return argv[1];
}

export function readPrivateJsonInput(inputPath, options) {
  const fail = options.fail;
  const maxBytes = options.maxBytes;
  const fileSystem = options.fileSystem ?? fs;
  if (typeof inputPath !== "string" || inputPath.length === 0 || !path.isAbsolute(inputPath)) {
    fail("invalid_input_path_not_absolute");
  }
  const normalized = path.normalize(inputPath);
  let stat;
  try {
    stat = fileSystem.lstatSync(normalized);
  } catch (error) {
    fail(error && error.code === "ENOENT"
      ? "invalid_input_file_missing"
      : "invalid_input_file_unreadable");
  }
  if (stat.isSymbolicLink()) fail("invalid_input_file_symlink");
  if (!stat.isFile()) fail("invalid_input_file_not_regular");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fail("invalid_input_file_permissions");
  }
  if (stat.size === 0) fail("invalid_input_file_empty");
  if (stat.size > maxBytes) fail("invalid_input_file_too_large");
  let raw;
  try {
    // Read the exact same normalized path that was statted above.
    raw = fileSystem.readFileSync(normalized, "utf8");
  } catch {
    fail("invalid_input_file_unreadable");
  }
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes === 0) fail("invalid_input_file_empty");
  if (rawBytes > maxBytes) fail("invalid_input_file_too_large");
  try {
    return JSON.parse(raw);
  } catch {
    fail("invalid_input_json");
  }
}
