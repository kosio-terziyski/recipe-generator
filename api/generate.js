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
        filter: {
          and: [
            { property: 'Активен', checkbox: { equals: true } },
            { property: 'Свързан с рецепти', checkbox: { equals: true } },
          ]
        },
        page_size: 40,
      }),
    });
    if (notionRes.ok) {
      const data = await notionRes.json();
      const lines = data.results.map(p => {
        const props = p.properties;
        const name = props['Продукт']?.title?.[0]?.text?.content || '';
        const priceB2C = props['Цена B2C (€ с ДДС)']?.number;
        if (!name) return null;
        return priceB2C ? `${name}: €${priceB2C}` : name;
      }).filter(Boolean);
      if (lines.length > 0) {
        productContext = `\nMEXGROCERIA ПРОДУКТИ (цени): ${lines.join('; ')}`;
      }
    }
  } catch (e) {}

  const fullPrompt = `Генерирай мексиканска рецепта.

${prompt}
${productContext}

ПРАВИЛА:
- Фира при месо: телешко 28%, свинско 22%, пиле 18% (qty е сурово тегло)
- Консервиран нопал = пресен нопал отцеден
- МАКСИМУМ 8 съставки и 5 стъпки за да е компактна рецептата
- Отговори САМО с валиден компактен JSON. Без markdown. Без текст преди/след. ЗАДЪЛЖИТЕЛНО затвори всички скоби накрая.

Формат:
{"name":"","name_en":"","type":"","cuisine":"","portions":4,"description":"","badges":[],"ingredients":[{"name":"","qty_per_portion":0.05,"unit":"кг","is_sub_recipe":false,"price_per_kg":5.0}],"sub_recipes":[],"steps":[{"num":1,"title":"","text":""}],"food_cost":{"notes":""},"related_dishes":[{"name":"","type":"","reason":""}],"chef_notes":""}`;

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
        max_tokens: 4000,
        messages: [{ role: 'user', content: fullPrompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: JSON.stringify(data) });

    let text = data.content?.[0]?.text || '';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      JSON.parse(text);
    } catch(e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        text = match[0];
        try { JSON.parse(text); }
        catch(e2) { return res.status(500).json({ error: 'JSON parse failed - truncated', raw: text.slice(-200) }); }
      } else {
        return res.status(500).json({ error: 'No JSON found', raw: text.substring(0, 300) });
      }
    }

    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
