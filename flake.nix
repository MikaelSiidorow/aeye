{
  description = "Local Claude Code and Codex session analytics";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    {
      self,
      nixpkgs,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      source =
        lib:
        lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./.npmrc
            ./drizzle
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./scripts
            ./src
            ./tsconfig.json
            ./vite.config.ts
          ];
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib;
          package = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "aeye";
            version = "0.0.1";
            src = source lib;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              pnpm = pkgs.pnpm_11;
              fetcherVersion = 4;
              hash = "sha256-Ct881MjiOpNpbhMAcii0gR7kA+fT4WlB8Qmg9rMwsWA=";
            };

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.nodejs_26
              pkgs.pnpm_11
              pkgs.pnpmConfigHook
            ];

            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              pnpm prune --prod --ignore-scripts
              mkdir -p "$out/bin" "$out/lib/aeye"
              cp -R build node_modules package.json "$out/lib/aeye/"
              makeWrapper ${pkgs.nodejs_26}/bin/node "$out/bin/aeye" \
                --add-flags "$out/lib/aeye/build" \
                --set-default HOST 127.0.0.1 \
                --set-default PORT 41837 \
                --set-default NODE_ENV production
              runHook postInstall
            '';

            meta = {
              description = "Local Claude Code and Codex session analytics";
              mainProgram = "aeye";
              platforms = systems;
            };
          });
        in
        {
          aeye = package;
          default = package;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.default;
        };
      });

      homeManagerModules.default = import ./nix/home-manager.nix self;

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_26
              pnpm_11
              sqlite
            ];
          };
        }
      );
    };
}
