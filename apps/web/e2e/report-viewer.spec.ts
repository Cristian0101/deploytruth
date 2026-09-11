import { expect, test } from '@playwright/test';

test('local report viewer shell stays local and communicates its passive role', async ({
  page,
}) => {
  await page.goto('/');

  await expect(page).toHaveTitle('DeployTruth');
  await expect(page.getByRole('heading', { name: 'DeployTruth' })).toBeVisible();
  await expect(page.getByText('Rule evaluation never occurs in this UI.')).toBeVisible();
});
