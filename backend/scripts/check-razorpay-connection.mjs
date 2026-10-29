import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only operator check. Never creates a plan, order, checkout, payment or refund.
// The response body can contain merchant records, so discard it without logging/parsing it.
export async function checkRazorpayConnection(env = process.env, fetchImpl = fetch) {
  const key = env.BILLING_RAZORPAY_KEY_ID || '';
  const secret = env.BILLING_RAZORPAY_KEY_SECRET || '';
  if (!/^rzp_live_[A-Za-z0-9]+$/.test(key) || !secret) {
    return { authenticated: false, reason: 'Live BILLING_RAZORPAY_KEY_ID and BILLING_RAZORPAY_KEY_SECRET are required.' };
  }
  try {
    const response = await fetchImpl('https://api.razorpay.com/v1/plans?count=1', {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Basic ' + Buffer.from(key + ':' + secret).toString('base64') }
    });
    await response.body?.cancel();
    return { authenticated: response.status === 200, http_status: response.status,
      scope: 'Read-only plans API access; payment capture, refunds, webhooks and recharge are not verified.' };
  } catch {
    return { authenticated: false, reason: 'Provider request failed or timed out; no credential or provider response details logged.' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkRazorpayConnection();
  console.log(JSON.stringify(result));
  process.exitCode = result.authenticated ? 0 : 1;
}
