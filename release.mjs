// Releases a new version of the plugin.
//
// Usage:
//   node release.mjs <version> [--notes "<release notes>"]
//
// Example:
//   node release.mjs 1.4.0 --notes "Auto-fetch URL title on save."
//
// Steps performed:
//   1. Preflight: must be on main, working tree clean, tag not already present.
//   2. Bump version in manifest.json and package.json (formatting preserved).
//   3. Build (npm run build).
//   4. Commit, tag, push branch and tag.
//   5. Create GitHub release with main.js, manifest.json, styles.css as assets.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const version = args[0];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("Usage: node release.mjs <semver> [--notes \"...\"]");
    console.error("Example: node release.mjs 1.4.0 --notes \"Bug fixes.\"");
    process.exit(1);
}

const notesIdx = args.indexOf("--notes");
const notes = notesIdx > -1 ? args[notesIdx + 1] : `Release ${version}`;

const out = (cmd, params = []) => execFileSync(cmd, params, { encoding: "utf8" }).trim();
const run = (cmd, params = []) => {
    console.log(`> ${cmd} ${params.join(" ")}`);
    execFileSync(cmd, params, { stdio: "inherit" });
};

// Preflight
const branch = out("git", ["branch", "--show-current"]);
if (branch !== "main") {
    console.error(`Must be on 'main' (currently on '${branch}').`);
    process.exit(1);
}
if (out("git", ["status", "--porcelain"])) {
    console.error("Working tree is not clean. Commit or stash first.");
    process.exit(1);
}
if (out("git", ["tag", "-l", version])) {
    console.error(`Tag ${version} already exists.`);
    process.exit(1);
}

// Bump version (preserves file formatting)
for (const file of ["manifest.json", "package.json"]) {
    const content = readFileSync(file, "utf8");
    const updated = content.replace(/("version":\s*)"\d+\.\d+\.\d+"/, `$1"${version}"`);
    if (updated === content) {
        console.error(`Failed to bump version in ${file}.`);
        process.exit(1);
    }
    writeFileSync(file, updated);
}

// Build
run("npm", ["run", "build"]);

// Commit, tag, push
run("git", ["add", "manifest.json", "package.json", "main.js"]);
run("git", ["commit", "-m", `chore: release ${version}`]);
run("git", ["tag", version]);
run("git", ["push"]);
run("git", ["push", "--tags"]);

// GitHub release
run("gh", [
    "release", "create", version,
    "--title", version,
    "--notes", notes,
    "main.js", "manifest.json", "styles.css",
]);

console.log(`\nReleased ${version}`);
