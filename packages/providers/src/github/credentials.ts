export const GITHUB_TOKEN_VARIABLES = ['DEPLOYTRUTH_GITHUB_TOKEN', 'GITHUB_TOKEN'] as const;

export type GitHubTokenVariable = (typeof GITHUB_TOKEN_VARIABLES)[number];

export interface GitHubCredential {
  /** The token value. Never serialized, logged, or placed on an observation. */
  readonly token: string;
  /** Which environment variable supplied it — safe to display (a name, never a value). */
  readonly variable: GitHubTokenVariable;
}

/**
 * Resolves the GitHub credential from runtime environment. `DEPLOYTRUTH_GITHUB_TOKEN` wins over
 * `GITHUB_TOKEN`; absent both means unauthenticated access, which is valid for public
 * repositories. Callers may report the variable name but never the token value.
 */
export const resolveGitHubCredential = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): GitHubCredential | undefined => {
  for (const variable of GITHUB_TOKEN_VARIABLES) {
    const token = env[variable]?.trim();
    if (token !== undefined && token.length > 0) {
      return { token, variable };
    }
  }
  return undefined;
};
