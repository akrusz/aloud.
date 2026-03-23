{
  description = "glooow - voice-based meditation facilitator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        # Development shell — Nix provides system deps, uv handles Python packages
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.python312
            pkgs.uv
            pkgs.portaudio
            pkgs.ffmpeg
            pkgs.git
          ];

          shellHook = ''
            echo "glooow development environment"
            echo ""

            # Set up library paths for native deps
            export LD_LIBRARY_PATH="${pkgs.portaudio}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

            # Create default config if missing
            if [ ! -f config/default.yaml ] && [ -f config/default.yaml.example ]; then
              cp config/default.yaml.example config/default.yaml
              echo "Created config/default.yaml from example"
            fi

            # Install Python deps if needed
            if [ ! -d .venv ]; then
              echo "Setting up Python environment..."
              uv venv
              uv pip install -r requirements.txt
              echo ""
            fi

            # Activate the venv
            source .venv/bin/activate

            echo "Commands:"
            echo "  python -m src.web           # start web server (native window)"
            echo "  python -m src.web --browser  # start web server (browser)"
            echo "  python -m src               # start CLI mode"
            echo ""
          '';
        };
      }
    );
}
