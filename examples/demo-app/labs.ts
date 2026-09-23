import type { IncomingMessage, ServerResponse } from 'node:http';
export type FixtureOrder = { id: string; state: 'pending' | 'confirmed'; confirmationCount: number };
const style = 'body{font:16px system-ui;background:#f5f3ed;color:#23382b;margin:0}nav{padding:25px 8%;border-bottom:1px solid #dbe1d4;display:flex;justify-content:space-between}main{max-width:850px;margin:65px auto;padding:0 25px}h1{font-size:46px;letter-spacing:-2px}small{letter-spacing:2px;color:#6e856f}article{background:white;padding:28px;border:1px solid #d9e1d3;border-radius:12px;margin:25px 0}button{padding:13px 20px;border:0;border-radius:7px;background:#284e39;color:white;font:inherit;cursor:pointer}p{color:#6e7c6c;line-height:1.7}.notice{padding:18px;border:1px solid #9dbf94;border-radius:6px;background:#e8f0df}footer{font-size:12px;color:#78906f;margin-top:35px}a{color:inherit}';
function html(title: string, body: string, script: string) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Acme fixtures</title><style>${style}</style></head><body><nav><b>acme / reliability lab</b><a href="/">Storefront</a></nav><main>${body}<footer>Local fixtures only. No gateway credentials or real payments.</footer></main><script>${script}</script></body></html>`; }
async function jsonBody(req: IncomingMessage) { let text = ''; for await (const bytes of req) { text += bytes; if (text.length > 4096) throw new Error('Body too large'); } return text ? JSON.parse(text) : {}; }

export async function serveLabs(req: IncomingMessage, res: ServerResponse, fixed: boolean, orders: Map<string, FixtureOrder>): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (path === '/api/products') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'tote', name: 'Everyday canvas tote', subtitle: 'Natural cotton' }], accessToken: 'seeded-api-secret-do-not-store', customerEmail: 'fixture@example.com' })); return true;
  }
  if (path.startsWith('/__fixtures/')) {
    const send = (data: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-DCR-Fixture': '1' }); res.end(JSON.stringify(data)); };
    try {
      if (path === '/__fixtures/orders' && req.method === 'GET') send({ protocol: 'dcr-fixture-v1' });
      else if (path === '/__fixtures/orders' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (typeof body.id !== 'string' || !/^dcr-[a-f0-9-]{36}$/.test(body.id) || body.amount !== 3200 || body.currency !== 'USD') throw new Error('Expected a deterministic DCR fixture order');
        if (orders.has(body.id)) { send({ error: 'Fixture ID already exists' }, 409); return true; }
        if (orders.size >= 1000) orders.delete(orders.keys().next().value!);
        const order: FixtureOrder = { id: body.id, state: 'pending', confirmationCount: 0 }; orders.set(order.id, order); send(order, 201);
      } else {
        const match = path.match(/^\/__fixtures\/orders\/([A-Za-z0-9_-]+)(\/(?:confirm|events))?$/), order = match ? orders.get(match[1]) : undefined;
        if (!order) send({ error: 'Unknown fixture order' }, 404);
        else if (!match![2] && req.method === 'GET') send(order);
        else if (match![2] === '/events' && req.method === 'POST') {
          const body = await jsonBody(req); if (!['delayed-callback', 'failed-callback'].includes(body.type) || body.eventId !== `confirmation-${order.id}`) throw new Error('Unsupported fixture callback');
          if (body.type === 'delayed-callback') await new Promise(resolve => setTimeout(resolve, 300));
          if (!fixed) { if (body.type === 'failed-callback') order.state = 'pending'; else order.confirmationCount++; }
          send(order);
        }
        else if (match![2] === '/confirm' && req.method === 'POST') {
          const body = await jsonBody(req); if (body.eventId !== `confirmation-${order.id}`) throw new Error('Expected this order’s fixture confirmation event');
          if (!fixed || order.state !== 'confirmed') order.confirmationCount++;
          order.state = 'confirmed'; send(order);
        } else send({ error: 'Unsupported fixture operation' }, 405);
      }
    } catch (error) { send({ error: String(error) }, 400); }
    return true;
  }
  if (path === '/catalog') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html('Catalog states', '<small>API CONTRACT FIXTURE</small><h1>The catalog</h1><div id="content" aria-live="polite">Loading products…</div>', `
      const fixed=${JSON.stringify(fixed)}, content=document.getElementById('content');
      async function load(){
        const response=await fetch('/api/products'), data=await response.json();
        if(fixed&&!response.ok){content.innerHTML='<p class="notice">'+(response.status===401?'Please sign in again':'We could not load products')+'</p>';return;}
        if(fixed&&data.items.length===0){content.innerHTML='<p class="notice">No products yet</p>';return;}
        const product=data.items[0];
        const subtitle=fixed?(product.subtitle??'No description available'):product.subtitle.toUpperCase();
        content.innerHTML='<article><h2 id="product-name"></h2><p id="subtitle"></p><p id="long-name"></p></article><p>Catalog ready</p>';
        document.getElementById('product-name').textContent=fixed?product.name.slice(0,120):product.name;
        document.getElementById('subtitle').textContent=subtitle;
        if(fixed&&product.name.length>120)document.getElementById('long-name').textContent='Product name is too long';
      }
      load();
    `)); return true;
  }
  const checkout = path.match(/^\/lab\/(checkout|success)\/([A-Za-z0-9_-]+)$/);
  if (checkout) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html('Checkout state', '<small>PAYMENT HISTORY FIXTURE</small><h1>Checkout state lab</h1><div id="checkout" aria-live="polite"></div>', `
      const fixed=${JSON.stringify(fixed)}, orderId=${JSON.stringify(checkout[2])}, container=document.getElementById('checkout');
      function success(){container.innerHTML='<article><h2 data-payment-state>Order confirmed</h2><p>The fixture server confirmed this order.</p><p>Browser history, refresh, and duplicate events must preserve that fact.</p></article>';}
      function pending(){container.innerHTML='<article><h2 data-payment-state>Awaiting confirmation</h2><p>Everyday canvas tote · $32.00 fixture total</p><button id="confirm">Confirm fixture order</button></article>';document.getElementById('confirm').onclick=async()=>{const response=await fetch('/__fixtures/orders/'+orderId+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:'confirmation-'+orderId})});if(!response.ok)throw new Error('Fixture confirmation failed');await response.json();history.pushState({},'', '/lab/success/'+orderId);success();};}
      async function restore(){if(!fixed){pending();return;}const response=await fetch('/__fixtures/orders/'+orderId);const order=await response.json();if(!response.ok)throw new Error('Fixture order not found');order.state==='confirmed'?success():pending();}
      window.addEventListener('popstate', restore);restore();
    `)); return true;
  }
  return false;
}
