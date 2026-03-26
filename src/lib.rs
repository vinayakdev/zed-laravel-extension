use zed_extension_api::{self as zed, LanguageServerId, Result};

const VIEW_LSP_JS: &str = include_str!("../lsp/view-lsp.js");

struct LaravelExtension {
    lsp_path: Option<String>,
}

impl zed::Extension for LaravelExtension {
    fn new() -> Self {
        Self { lsp_path: None }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let node = worktree
            .which("node")
            .ok_or_else(|| "node not found — install Node.js to enable view navigation".to_string())?;

        if self.lsp_path.is_none() {
            let lsp_dir = std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join("lsp");

            std::fs::create_dir_all(&lsp_dir).map_err(|e| e.to_string())?;

            let path = lsp_dir.join("view-lsp.js");
            std::fs::write(&path, VIEW_LSP_JS).map_err(|e| e.to_string())?;
            self.lsp_path = Some(path.to_string_lossy().to_string());
        }

        Ok(zed::Command {
            command: node,
            args: vec![self.lsp_path.clone().unwrap()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(LaravelExtension);
