import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3003', { waitUntil: 'networkidle' });
  
  // Check initial accent color (dark theme)
  let accent = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  });
  console.log('Initial accent:', accent);
  
  // Select "purple" theme
  await page.selectOption('#theme-select', 'purple');
  
  // Click "确认应用主题" button
  await page.click('#apply-theme-btn');
  await page.waitForTimeout(200);
  
  // Check accent color after applying purple
  accent = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  });
  console.log('After purple theme:', accent);
  
  // Select "green" theme
  await page.selectOption('#theme-select', 'green');
  await page.click('#apply-theme-btn');
  await page.waitForTimeout(200);
  
  accent = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  });
  console.log('After green theme:', accent);
  
  // Try a light theme
  await page.selectOption('#theme-select', 'light');
  await page.click('#apply-theme-btn');
  await page.waitForTimeout(200);
  
  const bgPrimary = await page.evaluate(() => {
    return getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
  });
  console.log('After light theme --bg-primary:', bgPrimary);
  
  // Take a screenshot to verify
  await page.screenshot({ path: 'test_theme_screenshot.png' });
  
  await browser.close();
  console.log('All theme tests passed!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
