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

        # Override Python package set with custom versions
        python = pkgs.python311.override {
          packageOverrides = self: super: {
            sounddevice = super.buildPythonPackage rec {
              pname = "sounddevice";
              version = "0.4.7";
              pyproject = true;
              src = self.fetchPypi {
                inherit pname version;
                sha256 = "sha256-abOGgY1QotUYYH1LlzRC6NUkdgx81si4vgPYyY/EvOc=";
              };
              build-system = [ self.setuptools ];
              propagatedBuildInputs = [ pkgs.portaudio self.cffi ];
              doCheck = false;
            };

            webrtcvad = super.buildPythonPackage rec {
              pname = "webrtcvad";
              version = "2.0.10";
              pyproject = true;
              src = self.fetchPypi {
                inherit pname version;
                sha256 = "sha256-8b7S+yW2P7expV1kCQyZPJyRZ7KEha4Lzdgc9u3pauo=";
              };
              build-system = [ self.setuptools ];
              doCheck = false;
            };

            simple-websocket = super.buildPythonPackage rec {
              pname = "simple-websocket";
              version = "1.0.0";
              pyproject = true;
              src = self.fetchPypi {
                inherit pname version;
                sha256 = "sha256-F9LHL0or2FF0qX4+TIiwHEDD+Bt7ZIsMw84TBZaJKMg=";
              };
              build-system = [ self.setuptools ];
              propagatedBuildInputs = [ self.wsproto ];
              doCheck = false;
            };
          };
        };

        # Python environment with all dependencies
        pythonEnv = python.withPackages (ps: with ps; [
          # Audio
          pyaudio
          sounddevice  # overridden version 0.4.7

          # VAD
          webrtcvad  # custom package

          # STT - Whisper
          openai-whisper

          # LLM clients
          anthropic
          openai
          httpx

          # Web interface
          flask
          flask-socketio
          simple-websocket  # custom package

          # Utilities
          pyyaml
          python-dotenv
          numpy
          scipy
        ]);

      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "glooow";
          version = "0.1.0";

          src = ./.;

          nativeBuildInputs = [ pkgs.makeWrapper ];

          buildInputs = [
            pythonEnv
            pkgs.portaudio
            pkgs.ffmpeg
          ];

          installPhase = ''
            mkdir -p $out/bin $out/share/glooow

            # Copy all source files
            cp -r src $out/share/glooow/
            cp -r config $out/share/glooow/
            mkdir -p $out/share/glooow/sessions

            # Create wrapper scripts
            makeWrapper ${pythonEnv}/bin/python $out/bin/glooow-web \
              --add-flags "-m src.web" \
              --set PYTHONPATH "$out/share/glooow" \
              --chdir "$out/share/glooow"

            makeWrapper ${pythonEnv}/bin/python $out/bin/glooow-cli \
              --add-flags "-m src" \
              --set PYTHONPATH "$out/share/glooow" \
              --chdir "$out/share/glooow"
          '';

          meta = with pkgs.lib; {
            description = "Voice-based meditation facilitator using LLMs and Whisper";
            license = licenses.mit;
            platforms = platforms.unix;
          };
        };

        # Development shell with all dependencies
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pythonEnv
            pkgs.portaudio
            pkgs.ffmpeg
            pkgs.git

            # Optional: add uv for compatibility with existing workflow
            pkgs.uv
          ];

          shellHook = ''
            echo "glooow development environment"
            echo "Python: ${python.version}"
            echo ""
            echo "Available commands:"
            echo "  python -m src.web    # Start web server"
            echo "  python -m src        # Start CLI mode"
            echo ""

            # Set up library path for portaudio
            export LD_LIBRARY_PATH="${pkgs.portaudio}/lib:$LD_LIBRARY_PATH"

            # Set up Python path to use local src directory
            export PYTHONPATH="$PWD:$PYTHONPATH"

            # Create sessions directory if it doesn't exist
            mkdir -p sessions

            # Create default config if it doesn't exist
            if [ ! -f config/default.yaml ]; then
              echo "Creating default configuration..."
              mkdir -p config
              cat > config/default.yaml << 'YAML'
            audio:
              input_device: default
              sample_rate: 16000
              channels: 1
              chunk_size: 480  # 30ms at 16kHz
              vad_sensitivity: 2  # 0-3, higher = more sensitive

            stt:
              engine: whisper
              model: small  # tiny, base, small, medium, large
              language: en
              device: auto  # auto, cpu, cuda, mps

            tts:
              engine: browser
              voice: "Zoe (Premium)"
              rate: 160  # words per minute

            llm:
              provider: claude_proxy
              model: claude-sonnet-4-6
              proxy_url: http://127.0.0.1:8317
              api_key: glooow
              ollama_url: http://localhost:11434
              ollama_model: llama3

              context:
                strategy: full
                window_size: 10
                max_tokens: 300

            pacing:
              response_delay_ms: 2000
              min_speech_duration_ms: 500
              extended_silence_sec: 300

            facilitation:
              directiveness: 3
              focuses: []
              qualities: []
              verbosity: low
              custom_instructions: |
                Feel free to suggest releasing the need to pay attention to anything specific.
                Trust the meditator's process.

            session:
              auto_save: true
              save_directory: sessions
              include_timestamps: true
            YAML
              echo "✓ Config created at config/default.yaml"
            fi
          '';
        };

        # App for nix run
        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/glooow-web";
        };
      }
    );
}
