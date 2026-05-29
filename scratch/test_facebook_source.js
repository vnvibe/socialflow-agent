const { launchBrowser } = require('../browser/launcher');

(async () => {
  try {
    const account = { id: 'test_empty_session', cookie_string: '' };
    const session = await launchBrowser(account, { headless: true });
    const page = await session.context.newPage();

    console.log('Navigating to standard Facebook (logged out)...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const src = await page.content();
    console.log('Source length:', src.length);

    // Let's test the regexes used in check-health.js
    const loggedInMatch = src.match(/"is_logged_in"\s*:\s*(true|false)/);
    const userIdMatch = src.match(/"USER_ID"\s*:\s*"(\d+)"/);
    const actorMatch = src.match(/"actorID"\s*:\s*"(\d+)"/);

    console.log('\n--- Regex Results ---');
    console.log('is_logged_in match:', loggedInMatch ? loggedInMatch[0] : 'NONE');
    console.log('USER_ID match:', userIdMatch ? userIdMatch[0] : 'NONE');
    console.log('actorID match:', actorMatch ? actorMatch[0] : 'NONE');

    // Check if there are other matches of USER_ID or actorID
    const allUserIds = src.match(/"USER_ID"\s*:\s*"[^"]*"/g);
    console.log('All USER_ID matches in source:', allUserIds);

    await session.context.close();
  } catch (err) {
    console.error(err);
  }
})();
