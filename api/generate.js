export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const MEX_DB_ID = '3700caa2630581179b76e4f78c9213f1';
  const ITEMS_DB_ID = '3700caa263058169b545cd6a84de3fcd';

  // 1. Вземи mexgroceria Products от Notion
  let productContext = '';
  try {
    const notionRes = await fetch(`https://api.notion.com/v1/databases/${MEX_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        filter: { property: 'Активен', checkbox: { equals: true } },
        page_size: 100,
      }),
    });

    if (notionRes.ok) {
      const data = await notionRes.json();
      const products = data.results.map(p => {
        const props = p.properties;
        const name = props['Продукт']?.title?.[0]?.text?.content || '';
        const cat = props['Категория']?.select?.name || '';
        const priceB2C = props['Цена B2C (€ с ДДС)']?.number || null;
        const priceHoreca = props['Цена HoReCa (€ без ДДС)']?.number || null;
        const recipeTags = props['Recipe tags']?.rich_text?.[0]?.text?.content || '';
        const inStock = props['На склад']?.checkbox !== false;
        if (!name) return null;
        const price = priceB2C ? `B2C €${priceB2C}` : '';
        const hor = priceHoreca ? `HoReCa €${priceHoreca}` : '';
        const stock = inStock ? '✓' : '✗ изчерпан';
        const tags = recipeTags ? ` [рецепти: ${recipeTags}]` : '';
        return `${name} (${cat}) | ${price} ${hor} | ${stock}${tags}`;
      }).filter(Boolean);

      productContext = `\n\n=== MEXGROCERIA КАТАЛОГ (${products.length} продукта) ===\n${products.join('\n')}`;
    }
  } catch (e) {
    productContext = '\n\n[Notion каталогът временно недостъпен — използвай ориентировъчни цени]';
  }

  // 2. Вземи суб-рецепти от Items
  let subRecipeContext = '';
  try {
    const itemsRes = await fetch(`https://api.notion.com/v1/databases/${ITEMS_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        filter: {
          and: [
            { property: 'Тип артикул', select: { equals: 'sub_recipe — prep рецепта' } },
            { property: 'Активен', checkbox: { equals: true } },
          ]
        },
        page_size: 50,
      }),
    });
    if (itemsRes.ok) {
      const data = await itemsRes.json();
      const subs = data.results.map(p => {
        const name = p.properties['Артикул']?.title?.[0]?.text?.content || '';
        return name || null;
      }).filter(Boolean);
      if (subs.length > 0) {
        subRecipeContext = `\n\n=== НАЛИЧНИ СУБ-РЕЦЕПТИ ===\n${subs.join('\n')}`;
      }
    }
  } catch (e) {}

  // 3. Обогати prompt-а
  const enrichedPrompt = prompt + productContext + subRecipeContext + `

ПРАВИЛА ЗА FOOD COST:
- Използвай цените от mexgroceria каталога за тези продукти
- Месо пазарни цени (€/кг): телешко 9-12, свинско 6-8, пиле 5-7, агнешко 10-14
- ФИРА: телешко 28%, свинско 22%, пиле 18% — qty_per_portion е СУРОВО тегло
- Консервиран нопал (Lol-Tun / La Costeña / San Marcos) = пресен нопал 1:1 (отцеден)
- Ако продукт е изчерпан — предложи алтернатива от каталога`;

  // 4. Извикай Claude
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: enrichedPrompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: JSON.stringify(data) });
    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text, notionConnected: productContext.includes('каталог') });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
