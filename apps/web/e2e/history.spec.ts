import { expect, test } from '@playwright/test';

const artifacts = 'output/playwright/m7';

test('History view loads the local run timeline', async ({ page }) => {
  await page.goto('/?fixture=history-regression');
  await page.getByRole('button', { name: 'History' }).click();
  const history = page.getByTestId('history-view');
  await expect(history).toBeVisible();
  await expect(history.getByText('PASS', { exact: true }).first()).toBeVisible();
  await expect(history.getByText('FAIL', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `${artifacts}/history.png`, fullPage: true });
});

test('PASS → FAIL comparison shows the new finding', async ({ page }) => {
  await page.goto('/?fixture=history-regression');
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: /FAIL/ }).first().click();
  await page.getByRole('button', { name: 'Compare to previous' }).click();
  const comparison = page.getByTestId('comparison-view');
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole('heading', { name: 'PASS → FAIL' })).toBeVisible();
  await expect(comparison.getByText('REGRESSION', { exact: true })).toBeVisible();
  await expect(page.getByTestId('finding-new')).toContainText('DEPLOYMENT_SHA_MISMATCH');
  await expect(
    comparison.getByText(/GitHub → Vercel|verified → failed|FAILED/i).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${artifacts}/comparison-regression.png`, fullPage: true });
});

test('FAIL → PASS comparison shows the resolved finding', async ({ page }) => {
  await page.goto('/?fixture=history-recovery');
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: /PASS/ }).first().click();
  await page.getByRole('button', { name: 'Compare to previous' }).click();
  await expect(page.getByRole('heading', { name: 'FAIL → PASS' })).toBeVisible();
  await expect(page.getByText('RECOVERED', { exact: true })).toBeVisible();
  await expect(page.getByTestId('finding-resolved')).toContainText('DEPLOYMENT_SHA_MISMATCH');
  await page.screenshot({ path: `${artifacts}/comparison-recovery.png`, fullPage: true });
});

test('historical snapshot is read-only and can return to latest', async ({ page }) => {
  await page.goto('/?fixture=history-regression');
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: /PASS/ }).first().click();
  await page.getByRole('button', { name: 'View snapshot' }).click();
  await expect(page.getByTestId('historical-banner')).toContainText('Historical run');
  await expect(page.getByTestId('historical-banner')).toContainText('Read-only');
  await expect(page.getByRole('button', { name: 'Re-run checks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to latest' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to latest' }).click();
  await expect(page.getByTestId('historical-banner')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Re-run checks' })).toBeVisible();
});

test('history comparison contains no secret-looking values', async ({ page }) => {
  await page.goto('/?fixture=history-regression');
  await page.getByRole('button', { name: 'History' }).click();
  await page.getByRole('button', { name: /FAIL/ }).first().click();
  await page.getByRole('button', { name: 'Compare to previous' }).click();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(
    /ghp_|Bearer\s|postgres(?:ql)?:\/\/|service_role|SUPABASE_SERVICE_ROLE_KEY/i,
  );
});
