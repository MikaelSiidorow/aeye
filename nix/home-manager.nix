self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.aeye;
  serviceEnvironment = {
    AEYE_CLAUDE_PROJECTS_PATH = cfg.claudeProjectsPath;
    AEYE_CODEX_HOME_PATH = cfg.codexHomePath;
    AEYE_DB_PATH = "${cfg.stateDirectory}/aeye.sqlite";
    HOST = "127.0.0.1";
    NODE_ENV = "production";
    ORIGIN = "http://127.0.0.1:${toString cfg.port}";
    PORT = toString cfg.port;
  };
in
{
  options.services.aeye = {
    enable = lib.mkEnableOption "the Aeye local session analytics service";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.aeye.packages.\${pkgs.system}.default";
      description = "Aeye package to run.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 41837;
      description = "Loopback TCP port for the local Aeye web interface.";
    };

    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/aeye";
      defaultText = lib.literalExpression ''"\${config.xdg.stateHome}/aeye"'';
      description = "Directory for Aeye's disposable SQLite index.";
    };

    claudeProjectsPath = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.claude/projects";
      defaultText = lib.literalExpression ''"\${config.home.homeDirectory}/.claude/projects"'';
      description = "Read-only Claude Code projects directory to index.";
    };

    codexHomePath = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.codex";
      defaultText = lib.literalExpression ''"\${config.home.homeDirectory}/.codex"'';
      description = "Read-only Codex home directory to index.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        home.packages = [ cfg.package ];
      }

      (lib.mkIf pkgs.stdenv.isLinux {
        systemd.user.services.aeye = {
          Unit = {
            Description = "Aeye local session analytics";
            After = [ "default.target" ];
          };
          Service = {
            Environment = lib.mapAttrsToList (name: value: "${name}=${value}") serviceEnvironment;
            ExecStart = lib.getExe cfg.package;
            Restart = "on-failure";
            RestartSec = 2;
            UMask = "0077";
          };
          Install.WantedBy = [ "default.target" ];
        };
      })

      (lib.mkIf pkgs.stdenv.isDarwin {
        launchd.agents.aeye = {
          enable = true;
          config = {
            EnvironmentVariables = serviceEnvironment;
            KeepAlive = true;
            ProcessType = "Background";
            ProgramArguments = [ (lib.getExe cfg.package) ];
            RunAtLoad = true;
          };
        };
      })
    ]
  );
}
