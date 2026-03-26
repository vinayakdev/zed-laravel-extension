use zed_extension_api::{self as zed, LanguageServerId, Result};

// Each module file is embedded at compile time and written to disk at runtime.
// Adding a new module = add an include_str! here + one entry in LSP_FILES below.
const LSP_FILES: &[(&str, &str)] = &[
    ("server.js",            include_str!("../lsp/server.js")),
    ("php/data.js",          include_str!("../lsp/php/data.js")),
    ("php/discovery.js",     include_str!("../lsp/php/discovery.js")),
    ("php/completions.js",   include_str!("../lsp/php/completions.js")),
    ("php/definition.js",    include_str!("../lsp/php/definition.js")),
    ("php/resolver.js",      include_str!("../lsp/php/resolver.js")),
    ("php/vendor.js",        include_str!("../lsp/php/vendor.js")),
    ("php/inference.js",     include_str!("../lsp/php/inference.js")),
    ("blade/data.js",        include_str!("../lsp/blade/data.js")),
    ("blade/views.js",       include_str!("../lsp/blade/views.js")),
    ("blade/components.js",  include_str!("../lsp/blade/components.js")),
    ("blade/completions.js", include_str!("../lsp/blade/completions.js")),
];

struct LaravelExtension {
    lsp_entry: Option<String>,
}

impl zed::Extension for LaravelExtension {
    fn new() -> Self {
        Self { lsp_entry: None }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let node = worktree
            .which("node")
            .ok_or_else(|| "node not found — install Node.js to enable Laravel support".to_string())?;

        if self.lsp_entry.is_none() {
            let lsp_dir = std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join("lsp");

            for (relative, content) in LSP_FILES {
                let file_path = lsp_dir.join(relative);
                std::fs::create_dir_all(file_path.parent().unwrap())
                    .map_err(|e| e.to_string())?;
                std::fs::write(&file_path, content)
                    .map_err(|e| e.to_string())?;
            }

            self.lsp_entry = Some(lsp_dir.join("server.js").to_string_lossy().to_string());
        }

        Ok(zed::Command {
            command: node,
            args: vec![self.lsp_entry.clone().unwrap()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(LaravelExtension);
