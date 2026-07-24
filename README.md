# Aeye

Aeye is a local web interface for Claude Code and Codex session analytics. It indexes session logs into a disposable SQLite database and serves the UI on the loopback interface.

Claude Code and Codex files remain the source of truth. Aeye reads and watches them, but never modifies them. Its only persistent write is its own index below `$XDG_STATE_HOME/aeye` by default.

## Run from the flake

```sh
nix run .
```

Open <http://127.0.0.1:41837>. The first start indexes the available local history and then watches for changes.

The default package also exposes the same command:

```sh
nix build
./result/bin/aeye
```

Set `AEYE_DB_PATH`, `AEYE_CLAUDE_PROJECTS_PATH`, or `AEYE_CODEX_HOME_PATH` to override the defaults. When running the command directly on another port, set matching `PORT` and `ORIGIN` values. The Home Manager module derives `ORIGIN` from its `port` option automatically.

## Home Manager

Add Aeye as a flake input and import its module:

```nix
{
  inputs.aeye = {
    url = "github:YOUR-USER/aeye";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ home-manager, nixpkgs, aeye, ... }: {
    homeConfigurations.your-user = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      modules = [
        aeye.homeManagerModules.default
        {
          services.aeye.enable = true;
        }
      ];
    };
  };
}
```

For a local checkout, use `url = "path:/absolute/path/to/aeye";`.

The module installs the `aeye` command and starts a user service on Linux or a launchd agent on Darwin. Available options include:

```nix
services.aeye = {
  enable = true;
  port = 41837;
  claudeProjectsPath = "${config.home.homeDirectory}/.claude/projects";
  codexHomePath = "${config.home.homeDirectory}/.codex";
  stateDirectory = "${config.xdg.stateHome}/aeye";
};
```

On Linux, inspect the service with:

```sh
systemctl --user status aeye
journalctl --user -u aeye -f
```
