{
  description = "Yaver — AI coding agent on your phone";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        version = "1.41.0";

        yaver = pkgs.buildGoModule {
          pname = "yaver";
          inherit version;
          src = ./desktop/agent;
          vendorHash = null; # Uses go modules
          CGO_ENABLED = 0;

          ldflags = [ "-s" "-w" ];

          meta = with pkgs.lib; {
            description = "AI coding agent on your phone — P2P remote control for Claude Code, Codex, Aider, Ollama";
            homepage = "https://yaver.io";
            license = licenses.mit;
            mainProgram = "yaver";
          };
        };
      in
      {
        packages = {
          default = yaver;
          yaver = yaver;
        };

        apps.default = {
          type = "app";
          program = "${yaver}/bin/yaver";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ yaver ];
        };
      });
}
