/**
 * 未来 · 自动抓取脚本
 * 
 * 功能：
 * 1. 访问配置中的监控网址，提取公告列表
 * 2. 关键词匹配 + 排除规则
 * 3. 去重（基于标题+发布日期）
 * 4. 结构化提取核心信息
 * 5. 输出 announcements.json
 * 
 * 运行方式：node scripts/scrape.js
 */

const fs = require('fs');
const path = require('path');

// 配置
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_PATH = path.join(DATA_DIR, 'announcements.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

// 加载配置
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[错误] 找不到配置文件:', CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// 加载历史数据（用于去重）
function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) {
    return { seen: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return { seen: {} };
  }
}

// 加载已有公告
function loadExisting() {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

// 保存数据
function saveData(announcements, history) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(announcements, null, 2), 'utf-8');
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
  console.log(`[完成] 共 ${announcements.length} 条公告，已保存`);
}

// 关键词匹配
function matchKeywords(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

// 排除规则
function shouldExclude(text, excludeKeywords) {
  if (!text || !excludeKeywords || excludeKeywords.length === 0) return false;
  const lower = text.toLowerCase();
  return excludeKeywords.some(kw => lower.includes(kw.toLowerCase()));
}

// 生成唯一ID
function generateId(title, source, date) {
  const clean = (title || '').replace(/\s+/g, '').slice(0, 20);
  return `${date || 'unknown'}_${source || 'unknown'}_${clean}`.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
}

// 计算清闲度
function calcLeisure(text, orgName) {
  const lower = (text + ' ' + (orgName || '')).toLowerCase();
  const busy = ['建设', '项目', '施工', '一线', '应急', '执法', '管理'];
  const leisure = ['服务', '促进', '联合社', '中心', '发展', '研究', '指导'];
  let score = 3; // 默认适中
  busy.forEach(w => { if (lower.includes(w)) score--; });
  leisure.forEach(w => { if (lower.includes(w)) score++; });
  return Math.max(1, Math.min(5, score));
}

// 提取公告信息（基础版 - 根据实际页面结构调整）
function extractAnnouncement(item, sourceName, sourceUrl) {
  const title = item.title || item.text || '未知标题';
  const link = item.link || item.url || '#';
  const date = item.date || item.pubDate || '';

  // 生成绝对URL
  let fullUrl = link;
  if (link && !link.startsWith('http')) {
    try {
      fullUrl = new URL(link, sourceUrl).href;
    } catch {
      fullUrl = link;
    }
  }

  // 类型判断
  let type = '国企人才引进';
  if (title.includes('泽州') || title.includes('事业编') || title.includes('事业单位')) {
    type = '泽州事业编/省考';
  }

  // 单位识别
  let org = '其他';
  const orgKeywords = {
    '城投': '晋城城投',
    '国投': '晋城国投',
    '丹河': '丹河新城',
    '中小企业': '中小企业中心',
    '城联社': '城联社',
    '工信': '晋城工信'
  };
  for (const [kw, name] of Object.entries(orgKeywords)) {
    if (title.includes(kw)) { org = name; break; }
  }

  // 岗位识别
  let pos = '管理岗';
  if (title.includes('工程')) pos = '工程管理岗';
  else if (title.includes('产业')) pos = '产业管理岗';
  else if (title.includes('技术')) pos = '技术岗';

  // 招录人数提取
  const countMatch = title.match(/招[收录聘](\d+)/);
  const count = countMatch ? parseInt(countMatch[1]) : 1;

  // 考核方式
  let interview = '笔试+面试';
  if (title.includes('免笔试') || title.includes('人才引进')) interview = '免笔试';

  // 学历
  let edu = '硕士';
  if (title.includes('博士')) edu = '博士';

  return {
    id: generateId(title, sourceName, date),
    title: title,
    url: fullUrl,
    source: sourceName,
    publishDate: date,
    regStart: '',
    regEnd: '',
    type: type,
    org: org,
    orgType: type.includes('事业') ? '🏛️事业编' : '🏭平台公司',
    pos: pos,
    count: count,
    edu: edu,
    gender: '不限',
    interview: interview,
    onlyFresh: false,
    expired: false,
    tags: type.includes('事业') ? ['部分匹配', '事业编'] : ['高度匹配', '企业高补'],
    leisure: calcLeisure(title, org),
    comp: count >= 5 ? '低' : count >= 3 ? '中' : '高',
    fullContent: title,
    createdAt: new Date().toISOString()
  };
}

// 主流程
async function main() {
  console.log('🌱 未来 · 自动抓取启动');
  const config = loadConfig();
  const history = loadHistory();
  let announcements = loadExisting();

  const results = [];
  let totalNew = 0;
  const siteStatus = [];

  // 使用内置 fetch（Node 18+）
  const isNode18 = process.version.startsWith('v18') || process.version.startsWith('v20') || process.version.startsWith('v22');

  for (const site of config.monitoredUrls) {
    if (!site.active) continue;
    console.log(`\n[抓取] ${site.name} - ${site.url}`);

    try {
      let html = '';
      
      if (isNode18) {
        // Node 18+ 有内置 fetch
        const response = await fetch(site.url, {
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        html = await response.text();
      } else {
        // 降级方案：使用 https 模块
        const https = require('https');
        html = await new Promise((resolve, reject) => {
          const req = https.get(site.url, { timeout: 15000 }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
      }

      // 简单解析标题
      const titleMatches = html.match(/<a[^>]*>([^<]{4,80})<\/a>/g) || [];
      const items = titleMatches.map(m => {
        const textMatch = m.match(/<a[^>]*>([^<]*)<\/a>/);
        const hrefMatch = m.match(/href=["']([^"']*)["']/);
        const text = textMatch ? textMatch[1].trim() : '';
        const href = hrefMatch ? hrefMatch[1] : '';
        return { title: text, link: href, date: '' };
      }).filter(i => i.title.length >= 6);

      // 关键词过滤
      const matched = [];
      for (const item of items) {
        if (shouldExclude(item.title, config.excludeKeywords)) continue;
        if (matchKeywords(item.title, config.keywords)) {
          matched.push(item);
        }
      }

      // 去重
      let siteNewCount = 0;
      for (const item of matched) {
        const aid = generateId(item.title, site.name, item.date);
        if (!history.seen[aid]) {
          history.seen[aid] = true;
          const ann = extractAnnouncement(item, site.name, site.url);
          results.push(ann);
          siteNewCount++;
        }
      }

      totalNew += siteNewCount;
      siteStatus.push({ name: site.name, status: 'success', message: `抓取正常，新发现 ${siteNewCount} 条` });
      console.log(`  完成：发现 ${matched.length} 条匹配，新增 ${siteNewCount} 条`);
    } catch (err) {
      siteStatus.push({ name: site.name, status: 'error', message: err.message });
      console.error(`  失败：${err.message}`);
    }
  }

  // 合并新结果到历史公告
  announcements = [...results, ...announcements];

  // 标记过期公告
  const now = new Date();
  announcements.forEach(a => {
    if (a.regEnd) {
      a.expired = new Date(a.regEnd) < now;
    }
  });

  // 按发布日期排序
  announcements.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));

  // 只保留最近200条
  if (announcements.length > 200) {
    announcements = announcements.slice(0, 200);
  }

  // 写入结果
  saveData(announcements, history);

  // 输出摘要
  const active = announcements.filter(a => !a.expired);
  console.log(`\n📊 摘要`);
  console.log(`  巡检站点：${siteStatus.length}/${config.monitoredUrls.length}`);
  console.log(`  新增公告：${totalNew} 条`);
  console.log(`  累计公告：${announcements.length} 条（其中 ${active.length} 条正在报名）`);
  console.log(`  巡检时间：${new Date().toLocaleString('zh-CN')}`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
