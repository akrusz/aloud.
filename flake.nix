{
  description = "aloud. — voice-based meditation facilitator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        commonInputs = [
          pkgs.python312
          pkgs.uv
          pkgs.portaudio
          pkgs.ffmpeg
          pkgs.git
        ];

        # GTK/WebKit2 deps for pywebview's native window
        desktopInputs = [
          pkgs.gtk3
          pkgs.webkitgtk_4_1
          pkgs.gobject-introspection
          pkgs.pkg-config
          pkgs.cairo
          pkgs.glib
          pkgs.wrapGAppsHook3
        ];

        makeShellHook = { requirementsFile, mode }: ''
          echo "aloud. development environment (${mode})"
          echo ""

          # Set up library paths for native deps (portaudio for audio, libstdc++ for numpy/scipy)
          export LD_LIBRARY_PATH="${pkgs.portaudio}/lib:${pkgs.stdenv.cc.cc.lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        '' + pkgs.lib.optionalString (mode == "desktop") ''
          export LD_LIBRARY_PATH="${pkgs.gtk3}/lib:${pkgs.webkitgtk_4_1}/lib:${pkgs.cairo}/lib:${pkgs.glib.out}/lib:$LD_LIBRARY_PATH"
          export GI_TYPELIB_PATH="${pkgs.gtk3}/lib/girepository-1.0:${pkgs.webkitgtk_4_1}/lib/girepository-1.0''${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
        '' + ''

          # Install Python deps if needed
          if [ ! -d .venv ]; then
            echo "Setting up Python environment..."
            uv venv
            uv pip install -r ${requirementsFile}
            echo ""
          fi

          # Activate the venv
          source .venv/bin/activate

          echo "Commands:"
        '' + (if mode == "desktop" then ''
          echo "  python -m src.web           # start (native window)"
          echo "  python -m src.web --browser  # start (browser)"
        '' else ''
          echo "  python -m src.web --browser  # start (opens in browser)"
        '') + ''
          echo "  ./scripts/start.sh          # full launcher (auto-bootstraps config)"
          echo ""
        '';
      in
      {
        # Default: native window via pywebview + GTK/WebKit2 (from Nix binary cache)
        devShells.default = pkgs.mkShell {
          buildInputs = commonInputs ++ desktopInputs;
          shellHook = makeShellHook {
            requirementsFile = "requirements.txt";
            mode = "desktop";
          };
        };

        # Browser-only: lighter, skips pywebview and GTK/WebKit2 deps
        # Usage: nix develop .#browser
        devShells.browser = pkgs.mkShell {
          buildInputs = commonInputs;
          shellHook = makeShellHook {
            requirementsFile = "requirements-browser.txt";
            mode = "browser";
          };
        };
      }
    );
}
