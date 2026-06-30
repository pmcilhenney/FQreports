import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "wrangler.jsonc");
const databaseName = process.env.FQREPORTS_D1_NAME || "fqreports";
const bucketName = process.env.FQREPORTS_R2_BUCKET || "fqreports-exports";
const localWrangler = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const wrangler = process.env.WRANGLER || (fs.existsSync(localWrangler) ? localWrangler : "wrangler");

function run(args, options = {}) {
  console.log(`$ ${wrangler} ${args.join(" ")}`);
  return execFileSync(wrangler, args, { cwd: root, encoding: "utf8", stdio: options.stdio || "pipe" });
}

function tryJson(args) {
  try {
    const output = run([...args, "--json"]);
    return JSON.parse(output || "null");
  } catch {
    return null;
  }
}

function readConfig() {
  return fs.readFileSync(configPath, "utf8");
}

function writeConfig(text) {
  fs.writeFileSync(configPath, text);
}

function readLocalSecret() {
  for (const file of [".dev.vars", ".env.local"]) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    const match = text.match(/^FLEXIQUIZ_API_KEY=(.*)$/m);
    if (!match) continue;
    return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

function ensureD1() {
  const config = readConfig();
  const existingId = config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
  if (existingId && !existingId.startsWith("__")) {
    console.log(`D1 database already configured: ${existingId}`);
    return existingId;
  }

  const list = tryJson(["d1", "list"]);
  const listed = Array.isArray(list) ? list.find((item) => item.name === databaseName) : null;
  let id = listed?.uuid || listed?.database_id || listed?.id;
  if (!id) {
    const output = run(["d1", "create", databaseName]);
    id = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  }
  if (!id) {
    throw new Error(`Could not create or find D1 database "${databaseName}".`);
  }
  writeConfig(config.replace("__FQREPORTS_D1_DATABASE_ID__", id));
  console.log(`Configured D1 database ${databaseName}: ${id}`);
  return id;
}

function ensureR2() {
  const list = tryJson(["r2", "bucket", "list"]);
  const exists = Array.isArray(list) && list.some((item) => item.name === bucketName || item.bucket_name === bucketName);
  if (exists) {
    console.log(`R2 bucket already exists: ${bucketName}`);
    return;
  }
  const result = spawnSync(wrangler, ["r2", "bucket", "create", bucketName], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && !`${result.stderr}${result.stdout}`.includes("already exists")) {
    throw new Error(result.stderr || result.stdout || `Could not create R2 bucket "${bucketName}".`);
  }
  console.log(`Ensured R2 bucket: ${bucketName}`);
}

function applyMigrations() {
  run(["d1", "migrations", "apply", databaseName, "--remote"], { stdio: "inherit" });
}

function putSecretFromEnv() {
  const secret = process.env.FLEXIQUIZ_API_KEY || readLocalSecret();
  if (!secret) {
    console.log("FLEXIQUIZ_API_KEY not present in this shell; skipping secret upload.");
    console.log("Set it later with: wrangler secret put FLEXIQUIZ_API_KEY");
    return;
  }
  const result = spawnSync(wrangler, ["secret", "put", "FLEXIQUIZ_API_KEY"], {
    cwd: root,
    input: secret,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Could not upload FLEXIQUIZ_API_KEY.");
  }
  console.log("Uploaded FLEXIQUIZ_API_KEY secret.");
}

ensureD1();
ensureR2();
applyMigrations();
putSecretFromEnv();
