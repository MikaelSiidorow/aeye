export interface Environment {
  databasePath: string;
}

function readPath(source: NodeJS.ProcessEnv, name: string, fallback: string) {
  const rawValue = source[name];
  if (rawValue === undefined) return fallback;

  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} must not contain a null byte`);
  }

  return value;
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return {
    databasePath: readPath(source, "AEYE_DB_PATH", "data/aeye.sqlite"),
  };
}

export const env = Object.freeze(loadEnvironment());
