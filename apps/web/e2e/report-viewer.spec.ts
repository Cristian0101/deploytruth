import { expect, test } from '@playwright/test';

const artifacts = 'output/playwright/m6';

test('healthy map renders the complete normalized evidence chain', async ({ page }) => {
  await page.goto('/?fixture=healthy');
  await expect(page).toHaveTitle('DeployTruth');
  await expect(page.getByRole('heading', { name: 'Truth Map' })).toBeVisible();
  await expect(page.getByLabel('GitHub VERIFIED')).toBeVisible();
  await expect(page.getByLabel('Vercel Production READY')).toBeVisible();
  await expect(page.getByLabel('Runtime VERIFIED')).toBeVisible();
  await expect(page.getByLabel('Supabase CONNECTED')).toBeVisible();
  await expect(page.getByLabel('Migration History VERIFIED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Source SHA verified: VERIFIED' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runtime SHA verified: VERIFIED' })).toBeVisible();
  await page.screenshot({ path: `${artifacts}/healthy-map.png`, fullPage: true });
});

test('deployment mismatch fails only GitHub to Vercel', async ({ page }) => {
  await page.goto('/?fixture=deployment-sha-mismatch');
  await expect(
    page.getByRole('button', {
      name: /Deployment SHA does not match source SHA: FAIL, open finding/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Vercel Production READY')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runtime SHA verified: VERIFIED' })).toBeVisible();
  await page.screenshot({ path: `${artifacts}/sha-mismatch.png`, fullPage: true });
});

test('runtime mismatch fails only Vercel to Runtime', async ({ page }) => {
  await page.goto('/?fixture=runtime-sha-mismatch');
  await expect(page.getByRole('button', { name: 'Source SHA verified: VERIFIED' })).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Runtime SHA does not match deployment SHA: FAIL, open finding/,
    }),
  ).toBeVisible();
  await expect(page.getByText('DEPLOYMENT_SHA_MISMATCH')).toHaveCount(0);
});

test('failed relationship opens factual Inspector and Escape closes it', async ({ page }) => {
  await page.goto('/?fixture=deployment-sha-mismatch');
  await page
    .getByRole('button', { name: /Deployment SHA does not match source SHA: FAIL/ })
    .click();
  const inspector = page.getByTestId('finding-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'DEPLOYMENT_SHA_MISMATCH' })).toBeVisible();
  await expect(inspector.getByText('FAIL', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText('HIGH', { exact: true })).toBeVisible();
  await expect(inspector.getByText('Expected', { exact: true })).toBeVisible();
  await expect(inspector.getByText('abc123', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText('Observed', { exact: true })).toBeVisible();
  await expect(inspector.getByText('def456', { exact: true }).first()).toBeVisible();
  await expect(inspector.getByText(/Confirm the target branch and redeploy/)).toBeVisible();
  await expect(inspector).not.toContainText('/v1/');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${artifacts}/inspector.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
});

test('Report view uses the same report, counts, verdict, and evidence sources', async ({
  page,
}) => {
  await page.goto('/?fixture=healthy');
  await expect(page.getByLabel('Run summary')).toContainText('7 verified');
  await page.getByRole('button', { name: 'Report' }).click();
  const report = page.getByTestId('report-view');
  await expect(report).toBeVisible();
  await expect(report.getByText('7 / 7 verified')).toBeVisible();
  await expect(report.getByText('GitHub API')).toBeVisible();
  await expect(report.getByText('Vercel API')).toBeVisible();
  await expect(report.getByText('Runtime Attestation')).toBeVisible();
  await expect(report.getByText('Database Inspection')).toBeVisible();
  await page.screenshot({ path: `${artifacts}/report.png`, fullPage: true });
});

test('warning state stays visibly distinct from failure', async ({ page }) => {
  await page.goto('/?fixture=warning');
  await expect(page.getByLabel('Run summary')).toContainText('1 warning');
  await expect(page.getByLabel('Run summary')).toContainText('0 failures');
});

test('unknown evidence renders UNKNOWN without fabricated certainty', async ({ page }) => {
  await page.goto('/?fixture=unknown');
  await expect(page.getByText('UNKNOWN', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Not observed|unknown/i).first()).toBeVisible();
});

test('database connection failure degrades only Runtime to Supabase', async ({ page }) => {
  await page.goto('/?fixture=database-unavailable');
  await expect(page.getByRole('button', { name: 'Source SHA verified: VERIFIED' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runtime SHA verified: VERIFIED' })).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Runtime database connection could not be verified: WARN/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('GitHub VERIFIED')).toBeVisible();
  await expect(page.getByLabel('Vercel Production READY')).toBeVisible();
  await expect(page.getByLabel('Run summary')).toContainText('0 failures');
  await expect(page.getByLabel('Run summary')).toContainText('2 warnings');
});

test('multiple independent findings do not turn the healthy middle edge red', async ({ page }) => {
  await page.goto('/?fixture=multiple-findings');
  await expect(
    page.getByRole('button', { name: /Deployment SHA does not match source SHA: FAIL/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runtime SHA verified: VERIFIED' })).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /Runtime database connection could not be verified: WARN/,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Run summary')).toContainText('2 warnings');
  await expect(page.getByLabel('Run summary')).toContainText('1 failure');
});

test('re-run disables duplicate action and updates without a page refresh', async ({ page }) => {
  let reruns = 0;
  await page.route('**/api/rerun', async (route) => {
    reruns += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const response = await page.request.get('/api/report?fixture=healthy');
    await route.fulfill({ response });
  });
  await page.goto('/?fixture=healthy');
  const rerun = page.getByRole('button', { name: 'Re-run checks' });
  await rerun.dblclick();
  await expect(page.getByRole('button', { name: 'Running checks…' })).toBeDisabled();
  await expect(page.getByText('Report updated')).toBeVisible();
  expect(reruns).toBe(1);
});

test('static mode disables re-run', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { token: 'static', static: true, rerunAvailable: false } }),
  );
  await page.goto('/?fixture=healthy');
  await expect(page.getByRole('button', { name: 'Static report' })).toBeDisabled();
});

test('browser output contains no secret-like material', async ({ page }) => {
  await page.goto('/?fixture=multiple-findings');
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(
    /ghp_|Bearer\s|postgres(?:ql)?:\/\/|service_role|SUPABASE_SERVICE_ROLE_KEY/i,
  );
});
