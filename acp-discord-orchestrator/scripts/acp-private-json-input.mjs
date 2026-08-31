import fs from "node:fs";
import path from "node:path";

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
