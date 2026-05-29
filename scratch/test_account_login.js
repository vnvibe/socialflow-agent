const { Client } = require('pg');
require('dotenv').config();
const { launchBrowser } = require('../browser/launcher');
const path = require('path');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL Database on VPS');

    // Get Do Hoang Nam account
    const accRes = await client.query("SELECT * FROM accounts WHERE id = '6010461b-97fc-40ce-b407-8cddf18d40e1'");
    if (accRes.rows.length === 0) {
      console.error('Account Do Hoang Nam not found!');
      await client.end();
      return;
    }

    const account = accRes.rows[0];
    console.log(`\nLaunching browser for account: ${account.username} (ID: ${account.id})`);
    
    // Launch browser
    const session = await launchBrowser(account, { headless: true });
    const page = await session.context.newPage();

    console.log('Navigating to Facebook...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait a few seconds for the page to stabilize
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const title = await page.title();
    console.log(`Final URL: ${finalUrl}`);
    console.log(`Page Title: ${title}`);

    // Take a screenshot and save to artifacts folder
    const artifactDir = 'C:\\Users\\1phut\\.gemini\\antigravity\\brain\\d6ef9256-cd1f-43f7-bed0-ec546c579f7d';
    const screenshotPath = path.join(artifactDir, 'do_hoang_nam_test.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    // Retrieve and log all cookies
    const cookies = await session.context.cookies(['https://www.facebook.com']);
    console.log(`\n--- Cookies in Browser Context (${cookies.length} total) ---`);
    for (const c of cookies) {
      console.log(`- ${c.name}: ${c.value.slice(0, 15)}... (domain: ${c.domain}, secure: ${c.secure})`);
    }

    // Close session
    await session.context.close();
    console.log('\nBrowser session closed successfully.');

  } catch (err) {
    console.error('An error occurred during browser test:', err);
  } finally {
    await client.end();
  }
})();
