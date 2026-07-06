import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

  const requests: Array<{ method: string; url: string }> = [];
  const responses: Array<{ status: number; url: string; contentType: string; bodyPreview?: string }> = [];

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('std.samr.gov.cn') || url.includes('openstd.samr.gov.cn') || url.includes('gb688.cn')) {
      requests.push({ method: request.method(), url });
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('std.samr.gov.cn') || url.includes('openstd.samr.gov.cn') || url.includes('gb688.cn')) {
      const contentType = response.headers()['content-type'] ?? '';
      let bodyPreview: string | undefined;
      if (contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('text/html')) {
        try {
          bodyPreview = (await response.text()).slice(0, 5000);
        } catch {
          bodyPreview = undefined;
        }
      }
      responses.push({
        status: response.status(),
        url,
        contentType,
        bodyPreview,
      });
    }
  });

  await page.goto('https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=96019B083A5A59FC7F84895DFFE7500B', {
    waitUntil: 'networkidle',
    timeout: 120000,
  });

  const title = await page.title();
  const bodyText = await page.locator('body').innerText();

  console.log('PAGE_TITLE:', title);
  console.log('BODY_PREVIEW_START');
  console.log(bodyText.slice(0, 10000));
  console.log('BODY_PREVIEW_END');

  console.log('REQUESTS_START');
  for (const request of requests) {
    console.log(JSON.stringify(request));
  }
  console.log('REQUESTS_END');

  console.log('RESPONSES_START');
  for (const response of responses) {
    console.log(JSON.stringify(response));
  }
  console.log('RESPONSES_END');

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
