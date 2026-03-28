use std::process::Command;

fn main() {
    // Re-run this script if these change
    println!("cargo:rerun-if-changed=package.json");
    println!("cargo:rerun-if-changed=scripts/bundle-parser.js");

    // Install node_modules if php-parser is missing
    if !std::path::Path::new("node_modules/php-parser").exists() {
        let status = Command::new("npm")
            .args(["install", "--silent"])
            .status()
            .expect("build.rs: `npm install` failed — ensure Node.js and npm are on PATH");
        if !status.success() {
            panic!("build.rs: npm install returned non-zero exit code");
        }
    }

    // Ensure output dir exists
    std::fs::create_dir_all("lsp/vendor")
        .expect("build.rs: could not create lsp/vendor/");

    // Bundle php-parser into a single CJS file
    let status = Command::new("npx")
        .args([
            "esbuild",
            "scripts/bundle-parser.js",
            "--bundle",
            "--platform=node",
            "--format=cjs",
            "--log-level=warning",
            "--outfile=lsp/vendor/php-parser.js",
        ])
        .status()
        .expect("build.rs: `npx esbuild` failed — ensure npm install has been run");

    if !status.success() {
        panic!("build.rs: esbuild exited with non-zero status");
    }
}
