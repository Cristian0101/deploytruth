export const SAMPLE_MANIFEST = `# DeployTruth never stores secret values in this file.
version: 1
project: my-app

environments:
  production:
    kind: production
    source:
      provider: github
      repository: owner/my-app
      branch: main
    deployment:
      provider: vercel
      project: my-app
    database:
      provider: supabase
      project_ref: replace-with-project-ref
    runtime:
      url: https://example.com/api/version
      expected_environment: production
    checks:
      local_git: true
      remote_source: true
      deployment_sha: true
      runtime_identity: true
      environment_isolation: true
`;
