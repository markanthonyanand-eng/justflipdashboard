const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const generatorTemplate = require('./generator-template');
const { themeRegistry, DEFAULT_THEME_KEY, getThemePalette } = require('./themeRegistry');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname.endsWith('backend') ? path.resolve(__dirname, '..') : __dirname;
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const PUBLIC_DIR = fs.existsSync(FRONTEND_DIR) ? FRONTEND_DIR : path.join(ROOT_DIR, 'public');
const DATA_DIR = fs.existsSync(path.join(BACKEND_DIR, 'data')) ? path.join(BACKEND_DIR, 'data') : path.join(ROOT_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const SUPABASE_SQL_FILE = path.join(DATA_DIR, 'supabase_schema.sql');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'generated');
const SKILL_PATH = 'C:\\Users\\Lenovo\\.gemini\\config\\skills\\LandingPageAgent\\SKILL.md';
const activeLandingPageStagingPaths = new Set();

function getCodingAgentConfig() {
  const provider = (process.env.JUSTFLIP_CODING_AGENT_PROVIDER || 'opencode').trim().toLowerCase();
  const defaults = {
    copilot: { command: 'copilot', args: ['-p', '{prompt}', '--allow-all-tools'] },
    claude: { command: 'claude', args: ['-p', '{prompt}', '--dangerously-skip-permissions'] },
    opencode: { command: 'opencode', args: ['run', '{prompt}', '--auto'] }
  };
  const defaultConfig = defaults[provider] || defaults.copilot;
  const command = (process.env.JUSTFLIP_CODING_AGENT_COMMAND || defaultConfig.command).trim();
  let args = defaultConfig.args;
  if (process.env.JUSTFLIP_CODING_AGENT_ARGS) {
    try {
      const configuredArgs = JSON.parse(process.env.JUSTFLIP_CODING_AGENT_ARGS);
      if (!Array.isArray(configuredArgs) || configuredArgs.some(arg => typeof arg !== 'string')) {
        throw new Error('JUSTFLIP_CODING_AGENT_ARGS must be a JSON array of strings.');
      }
      args = configuredArgs;
    } catch (error) {
      throw new Error(`Invalid coding-agent argument configuration: ${error.message}`);
    }
  }
  return { provider, command, args };
}

function getSupabaseAuthConfig() {
  const cfg = getConfig();
  return {
    url: (process.env.VITE_SUPABASE_URL || cfg.supabaseUrl || '').trim().replace(/\/$/, ''),
    anonKey: (process.env.VITE_SUPABASE_ANON_KEY || cfg.supabaseAnonKey || '').trim()
  };
}

async function getAuthenticatedSupabaseUser(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const { url, anonKey } = getSupabaseAuthConfig();
  if (!token || !url || !anonKey) return null;

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return null;
  return response.json();
}

// Ensure data & generated directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function getLocalSites() {
  if (fs.existsSync(SITES_FILE)) {
    try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveLocalSites(sites) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2), 'utf8');
}

function registerOrUpdateSite(siteData) {
  const sites = getLocalSites();
  const idx = sites.findIndex(s => s.site_id === siteData.site_id);
  const now = new Date().toISOString();
  let updatedSite;
  if (idx !== -1) {
    sites[idx] = { ...sites[idx], ...siteData, updated_at: now };
    delete sites[idx].total_leads;
    delete sites[idx].leads_count;
    updatedSite = sites[idx];
  } else {
    updatedSite = {
      site_id: siteData.site_id,
      project_name: siteData.project_name || 'Luxury Residences',
      developer_name: siteData.developer_name || 'Premier Developer',
      live_url: siteData.live_url || `/generated/${siteData.site_id}/index.html`,
      preview_url: siteData.preview_url || `/generated/${siteData.site_id}/index.html`,
      status: siteData.status || 'live',
      created_at: now,
      updated_at: now
    };
    sites.unshift(updatedSite);
  }
  saveLocalSites(sites);

  // If Supabase or Firebase is configured, asynchronously sync site to cloud
  const cfg = getConfig();
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    syncSiteToSupabase(updatedSite, cfg).catch(() => {});
  } else if (cfg.firebaseProjectId) {
    syncSiteToFirebase(updatedSite, cfg).catch(() => {});
  }
}

// --------------------------------------------------------------------------
// Firebase Firestore REST Serializers & Helpers (Zero npm dependencies)
// --------------------------------------------------------------------------

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof val === 'number') {
      fields[key] = Number.isInteger(val) ? { integerValue: val.toString() } : { doubleValue: val };
    } else if (typeof val === 'boolean') {
      fields[key] = { booleanValue: val };
    } else if (typeof val === 'object') {
      fields[key] = { stringValue: JSON.stringify(val) };
    } else {
      fields[key] = { stringValue: val.toString() };
    }
  }
  return { fields };
}

function fromFirestoreDoc(doc) {
  if (!doc) return null;
  const res = {};
  if (doc.name) {
    const parts = doc.name.split('/');
    res.id = parts[parts.length - 1];
  }
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) {
      if (v.stringValue !== undefined) res[k] = v.stringValue;
      else if (v.integerValue !== undefined) res[k] = Number(v.integerValue);
      else if (v.doubleValue !== undefined) res[k] = Number(v.doubleValue);
      else if (v.booleanValue !== undefined) res[k] = v.booleanValue;
      else if (v.timestampValue !== undefined) res[k] = v.timestampValue;
      else if (v.nullValue !== undefined) res[k] = null;
      else res[k] = v;
    }
  }
  if (doc.createTime && !res.created_at) res.created_at = doc.createTime;
  return res;
}

async function syncSiteToFirebase(site, cfg) {
  try {
    const projectId = cfg.firebaseProjectId.trim();
    const apiKeyParam = cfg.firebaseApiKey ? `?key=${cfg.firebaseApiKey.trim()}` : '';
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/sites/${encodeURIComponent(site.site_id)}${apiKeyParam}`;

    const body = toFirestoreFields({
      site_id: site.site_id,
      project_name: site.project_name,
      developer_name: site.developer_name,
      live_url: site.live_url,
      preview_url: site.preview_url || '',
      status: site.status || 'live',
      updated_at: new Date().toISOString()
    });

    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      console.log(`[Studio Firebase] Synced site "${site.site_id}" to Firestore collection 'sites'`);
    } else {
      const errText = await res.text();
      console.warn(`[Studio Firebase] Sync site error HTTP ${res.status}:`, errText);
    }
  } catch (e) {
    console.warn('[Studio Firebase] Failed to sync site to Firebase:', e.message);
  }
}

async function fetchSitesFromFirebase(cfg) {
  try {
    const projectId = cfg.firebaseProjectId.trim();
    const apiKeyParam = cfg.firebaseApiKey ? `?key=${cfg.firebaseApiKey.trim()}` : '';
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/sites${apiKeyParam}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const docs = data.documents || [];
      return docs.map(fromFirestoreDoc);
    }
  } catch (e) {
    console.warn('[Studio Firebase] Fetch sites failed, using local store:', e.message);
  }
  return null;
}

// --------------------------------------------------------------------------
// Supabase REST Helpers
// --------------------------------------------------------------------------

function normalizeSupabaseUrl(url) {
  if (!url) return '';
  url = url.trim();
  const dashMatch = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9_-]+)/i);
  if (dashMatch) {
    return `https://${dashMatch[1]}.supabase.co`;
  }
  return url.replace(/\/$/, '');
}

async function syncSiteToSupabase(site, cfg) {
  try {
    const base = normalizeSupabaseUrl(cfg.supabaseUrl);
    const url = `${base}/rest/v1/sites`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': cfg.supabaseAnonKey,
        'Authorization': `Bearer ${cfg.supabaseAnonKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        site_id: site.site_id,
        project_name: site.project_name,
        developer_name: site.developer_name,
        live_url: site.live_url,
        status: site.status || 'live'
      })
    });
  } catch (e) {
    console.warn('[Studio Supabase] Failed to sync site to Supabase:', e.message);
  }
}

async function fetchSitesFromSupabase(cfg) {
  try {
    const base = normalizeSupabaseUrl(cfg.supabaseUrl);
    const url = `${base}/rest/v1/sites?select=*&order=created_at.desc`;
    const res = await fetch(url, {
      headers: {
        'apikey': cfg.supabaseAnonKey,
        'Authorization': `Bearer ${cfg.supabaseAnonKey}`
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[Studio Supabase] Fetch sites failed, using local store:', e.message);
    return null;
  }
}

function getSkillInstructions() {
  if (fs.existsSync(SKILL_PATH)) {
    return fs.readFileSync(SKILL_PATH, 'utf8');
  }
  return `You are LandingPageAgent: Master real estate landing page architect. Generate a complete, production-ready, mobile-responsive single-page landing page in HTML5 with Tailwind CSS CDN and vanilla JS. Include all standard 18 sections: sticky topbar, hero with form, quick facts scale grid, narrative, specs table, brochure teaser, dynamic pricing matrix, location commute hub, statement break, RERA badges, tabbed floor plans, amenities, photo gallery, virtual tour, master plan, technical specs, developer heritage, and site visit booking form with FAQs.`;
}

function isFullPageDesignPrompt(message) {
  const text = String(message || '');
  return text.length >= 1200
    && /(?:create|build|generate|design).{0,120}landing\s+page/i.test(text)
    && /(?:design\s+direction|visual\s+direction|colou?r\s+(?:system|palette)|typography)/i.test(text);
}

function resolveDesignBriefLocation(designBrief, dashboardLocation) {
  const opening = String(designBrief || '').split(/[\n.]/, 1)[0];
  const locationMatch = opening.match(/\b(Gurugram|Gurgaon|New Delhi|Delhi|Noida|Bengaluru|Bangalore|Manipal|Udupi|Mangalore|Mangaluru|Mumbai|Pune|Hyderabad|Chennai|Kochi|Dubai)\b/i);
  if (!locationMatch) return dashboardLocation || '';
  const requestedCity = locationMatch[1];
  const currentLocation = String(dashboardLocation || '');
  if (currentLocation && new RegExp(requestedCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(currentLocation)) {
    return currentLocation;
  }
  return /gurgaon/i.test(requestedCity) ? 'Gurugram' : requestedCity;
}

function locationConflictForText(requestedLocation, sourceText) {
  const location = String(requestedLocation || '').toLowerCase();
  const text = String(sourceText || '');
  const bengaluruEvidence = /\b(?:bengaluru|bangalore|north bengaluru|devanahalli|kempegowda|aerospace park)\b|prestige-parklane-bangalore/i;
  if (/gurugram|gurgaon/.test(location)
    && (bengaluruEvidence.test(text) || /\bkarnataka\b|PRM\/KA\/RERA/i.test(text))) {
    return 'Bengaluru-specific facts or media';
  }
  if (/manipal|udupi/.test(location) && bengaluruEvidence.test(text)) {
    return 'Bengaluru-specific facts or media';
  }
  if (/bengaluru|bangalore/.test(location)
    && /\b(?:gurugram|gurgaon|haryana)\b|HRERA|HARERA/i.test(text)) {
    return 'Gurugram-specific facts or media';
  }
  return '';
}

function findDashboardLocationConflict(designBrief, projectFacts) {
  const requestedLocation = resolveDesignBriefLocation(designBrief, '');
  if (!requestedLocation || !projectFacts || typeof projectFacts !== 'object') return '';
  const locationFieldPattern = /location|map|coordinate|commute|rera|hero|story|image|gallery|brochure|tour|banner|phone|whatsapp|faq/i;
  const locationFacts = Object.entries(projectFacts)
    .filter(([key]) => locationFieldPattern.test(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return locationConflictForText(requestedLocation, locationFacts);
}

function extractSelfContainedBriefProjectFacts(designBrief) {
  const text = String(designBrief || '');
  const readLine = pattern => {
    const match = text.match(pattern);
    return match ? match[1].trim().replace(/^["'“”]+|["'“”]+$/g, '') : '';
  };
  const projectName = readLine(/^\s*[•*-]?\s*Project\s+Name\s*:\s*([^\r\n]+)/im);
  const developerName = readLine(/^\s*[•*-]?\s*Developer(?:\s*\/\s*Promoter)?\s*:\s*([^\r\n]+)/im)
    || readLine(/^\s*[•*-]?\s*Legal\s+Entity\s*:\s*([^\r\n]+)/im);
  const location = readLine(/^\s*[•*-]?\s*(?:Micro-Market\s+Location|Site\s+Location|Location)\s*:\s*([^\r\n]+)/im);
  const reraId = readLine(/^\s*[•*-]?\s*(?:Official\s+)?RERA(?:\s+Registration)?(?:\s+No\.?|\s+Number)?\s*:\s*([^\r\n]+)/im);
  const sanctioningAuthority = readLine(/^\s*[•*-]?\s*Sanction\s+Authority\s*:\s*([^\r\n]+)/im);
  const possessionTimeline = readLine(/^\s*[•*-]?\s*Possession\s+Timeline\s*:\s*([^\r\n]+)/im);
  const landExtent = readLine(/^\s*[•*-]?\s*Land\s+Extent\s*:\s*([^\r\n]+)/im);
  const openSpace = readLine(/^\s*[•*-]?\s*Open\s+Space\s+Ratio\s*:\s*([^\r\n]+)/im);
  const towerStature = readLine(/^\s*[•*-]?\s*Architectural\s+Stature\s*:\s*([^\r\n]+)/im);
  const totalResidences = readLine(/^\s*[•*-]?\s*Total\s+Residences\s*:\s*([^\r\n]+)/im);
  const startingPrice = readLine(/^\s*[•*-]?\s*Starting\s+Price\s+Callout\s*:\s*([^\r\n]+)/im);
  const configuration = readLine(/^\s*[•*-]?\s*Typologies\s*:\s*([^\r\n]+)/im);

  const factCount = [reraId, sanctioningAuthority, possessionTimeline, landExtent, openSpace, towerStature, totalResidences, startingPrice, configuration]
    .filter(Boolean).length;
  const explicitlyFictional = /\b(?:fictional|imaginary|not a real (?:property|project)|design demonstration only)\b/i.test(text);
  if (projectName && developerName && location && explicitlyFictional) {
    return {
      projectName,
      developerName: developerName.replace(/^fictional concept by\s*/i, '').trim() || developerName,
      location,
      projectStatus: 'Fictional design concept; not a real or registered property',
      startingPrice: readLine(/^\s*[•*-]?\s*Price\s*:\s*([^\r\n]+)/im) || 'On Request',
      reraStatus: 'Not applicable — fictional concept',
      configuration: 'Details on request',
      factsSource: 'Explicitly fictional concept brief; no real project facts or dashboard media'
    };
  }
  if (!projectName || !developerName || !location || factCount < 4) return null;

  return {
    projectName,
    developerName,
    location,
    legalEntity: readLine(/^\s*[•*-]?\s*Legal\s+Entity\s*:\s*([^\r\n]+)/im),
    reraId,
    sanctioningAuthority,
    possessionTimeline,
    landExtent,
    openSpace,
    towerStature,
    totalResidences,
    startingPrice,
    configuration,
    factsSource: 'Complete project specifications in the current user brief'
  };
}

function sanitizeDashboardFacts(value, key = '') {
  if (/(?:api.?key|token|secret|password|authorization|engineMode)/i.test(key)) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) return '[Image uploaded in the studio]';
    return value.length > 20000 ? `${value.slice(0, 20000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeDashboardFacts(item)).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, childValue]) => [childKey, sanitizeDashboardFacts(childValue, childKey)])
      .filter(([, childValue]) => childValue !== undefined));
  }
  return value;
}

function validateOpenCodeLandingPage(html, designBrief, projectName, projectFacts = {}) {
  const bodyMatch = typeof html === 'string' ? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) : null;
  const bodyText = bodyMatch
    ? bodyMatch[1]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[^]*?-->/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    : '';
  const styleOpenCount = typeof html === 'string' ? (html.match(/<style\b/gi) || []).length : 0;
  const styleCloseCount = typeof html === 'string' ? (html.match(/<\/style>/gi) || []).length : 0;
  const scriptOpenCount = typeof html === 'string' ? (html.match(/<script\b/gi) || []).length : 0;
  const scriptCloseCount = typeof html === 'string' ? (html.match(/<\/script>/gi) || []).length : 0;

  if (typeof html !== 'string' || html.length < 2000 || !/<!doctype\s+html/i.test(html)
    || !/<html\b/i.test(html) || !/<head\b[^>]*>[\s\S]*?<\/head>/i.test(html)
    || !bodyMatch || bodyText.length < 100 || !/<\/html>\s*$/i.test(html)
    || styleOpenCount !== styleCloseCount || scriptOpenCount !== scriptCloseCount) {
    throw new Error('OpenCode did not produce a complete HTML landing page.');
  }
  const normalizedProjectName = String(projectName || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedBodyText = bodyText.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalizedProjectName && !normalizedBodyText.includes(normalizedProjectName)) {
    throw new Error(`OpenCode output does not identify the requested project "${projectName}".`);
  }
  const expectedDeveloper = String(projectFacts?.developerName || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (expectedDeveloper && !normalizedBodyText.includes(expectedDeveloper)) {
    throw new Error(`OpenCode output does not identify the requested developer "${projectFacts.developerName}".`);
  }
  const expectedRera = String(projectFacts?.reraId || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (expectedRera && !normalizedBodyText.includes(expectedRera)) {
    throw new Error('OpenCode output omitted the project RERA number supplied in the authoritative facts.');
  }
  const requestedLocation = resolveDesignBriefLocation(designBrief, '');
  const locationConflict = locationConflictForText(requestedLocation, html);
  if (locationConflict) {
    throw new Error(`OpenCode output includes ${locationConflict} although the brief requests ${requestedLocation}.`);
  }
  const promptLead = String(designBrief || '').trim().slice(0, 100);
  if (promptLead.length >= 60 && html.toLowerCase().includes(promptLead.toLowerCase())) {
    throw new Error('OpenCode copied the design prompt into the page instead of applying it.');
  }
  const requestedColors = [...new Set(String(designBrief || '').match(/#[0-9a-f]{6}\b/gi) || [])];
  const missingColors = requestedColors.filter(color => !html.toLowerCase().includes(color.toLowerCase()));
  if (missingColors.length > 0) {
    throw new Error(`OpenCode output omitted requested palette colors: ${missingColors.join(', ')}.`);
  }
  return true;
}

async function generateLandingPageWithOpenCode(options) {
  const stagingKey = path.resolve(options.stagingPath);
  if (activeLandingPageStagingPaths.has(stagingKey)) {
    throw new Error('A landing page request for this project is already running. Wait for it to finish before trying again.');
  }
  activeLandingPageStagingPaths.add(stagingKey);
  try {
    return await generateLandingPageWithOpenCodeTask(options);
  } finally {
    activeLandingPageStagingPaths.delete(stagingKey);
  }
}

async function generateLandingPageWithOpenCodeTask({ projectName, projectFacts, projectFactsSource = 'dashboard', designBrief, request, sourcePath, stagingPath }) {
  if (!fs.existsSync(SKILL_PATH)) throw new Error(`Required LandingPageAgent skill file was not found: ${SKILL_PATH}`);
  const skillInstructions = getSkillInstructions();
  if (!skillInstructions.trim()) throw new Error('LandingPageAgent SKILL.md is empty.');
  const projectFactsAuthority = projectFactsSource === 'brief'
    ? 'The current user brief contains a complete, named project specification. Treat that specification as the sole factual source for this new project. The dashboard JSON belongs to a different selected project and must be ignored completely; never merge its developer, location, RERA, pricing, contact, map, amenities, or media into this page. Do not stop to ask which source to use.'
    : 'Use the dashboard JSON as the only source of project facts. Do not invent missing facts; omit them or label them "On Request" / "To be confirmed". Never use a location-specific fact, contact, map, RERA record, brochure, or image that identifies another city or project. Only use media explicitly supplied for this project; if no matching media is available, use a restrained CSS composition instead of borrowing another project’s assets. If the dashboard values conflict with the requested location, stop and report the conflict rather than creating or publishing a mixed-location page.';

  const taskPrompt = `Create or update a complete, production-ready real-estate landing page for ${projectName}.

Treat this as a fresh, standalone task. Ignore design directions and project details from earlier messages in the OpenCode conversation. The project identity must remain "${projectName}"; do not substitute another real-world project. Read and follow the LandingPageAgent skill below as a production checklist. The current user's design brief controls the visual direction and exact palette, even if prior conversation or skill examples use a different theme. Extract useful requirements from the brief; never paste its instructions, examples, or placeholder labels into the visible page. ${projectFactsAuthority}

${sourcePath ? `Use the existing page at "${sourcePath}" as the starting point and apply only this new request: ${request}` : 'Create the page from scratch for this request.'}

Write the finished HTML document to this exact path: "${stagingPath}". Do not edit any other files. The page must include responsive styling and working page interactions. Use the exact colors from the design brief in the actual CSS and keep their assigned roles. Do not substitute a preset theme.

<dashboard_project_data_json>
${JSON.stringify(projectFacts, null, 2)}
</dashboard_project_data_json>

<user_design_brief>
${designBrief}
</user_design_brief>

<current_request>
${request}
</current_request>

<landing_page_agent_skill_md>
${skillInstructions}
</landing_page_agent_skill_md>

<completion_contract>
You must create the staging file using an available file-writing tool. Do not stop after describing the page, printing code in chat, or claiming that the file was written. Before reporting completion, verify that the exact staging path exists, is a complete HTML file, and contains the page you generated.
</completion_contract>`;

  if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
  let stableSince = 0;
  let lastMtime = 0;
  let lastValidationError = null;
  let invalidOutputSince = 0;
  let invalidOutputMtime = 0;
  const outputIsStable = () => {
    if (!fs.existsSync(stagingPath)) {
      lastValidationError = new Error('OpenCode has not written the landing page file yet.');
      invalidOutputSince = invalidOutputSince || Date.now();
      return false;
    }
    try {
      const stat = fs.statSync(stagingPath);
      const html = fs.readFileSync(stagingPath, 'utf8');
      validateOpenCodeLandingPage(html, designBrief, projectName, projectFacts);
      lastValidationError = null;
      invalidOutputSince = 0;
      invalidOutputMtime = 0;
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        stableSince = Date.now();
        return false;
      }
      return stableSince > 0 && Date.now() - stableSince >= 2500;
    } catch (error) {
      stableSince = 0;
      lastValidationError = error;
      try {
        const mtime = fs.statSync(stagingPath).mtimeMs;
        if (mtime !== invalidOutputMtime) {
          invalidOutputMtime = mtime;
          invalidOutputSince = Date.now();
        }
      } catch (_) {
        invalidOutputSince = invalidOutputSince || Date.now();
      }
      return false;
    }
  };

  // Full-page builds can exceed fifteen minutes while OpenCode writes and
  // reviews the HTML. Keep the dashboard request open through longer builds.
  await runCodingAgent(taskPrompt, process.cwd(), 1500000, outputIsStable, () => ({
    message: lastValidationError?.message,
    since: invalidOutputSince
  }));
  const html = fs.readFileSync(stagingPath, 'utf8');
  validateOpenCodeLandingPage(html, designBrief, projectName, projectFacts);
  return html;
}

async function generateLandingPageWithGemini({ projectName, projectFacts, projectFactsSource = 'dashboard', designBrief, request, stagingPath, apiKey, preferredModel }) {
  if (!fs.existsSync(SKILL_PATH)) throw new Error(`Required LandingPageAgent skill file was not found: ${SKILL_PATH}`);
  const skillInstructions = getSkillInstructions();
  if (!skillInstructions.trim()) throw new Error('LandingPageAgent SKILL.md is empty.');
  const authority = projectFactsSource === 'brief'
    ? 'The current brief contains the complete facts for this new project. Treat those as the sole facts. Ignore dashboard facts from a different selected project.'
    : 'Use the dashboard JSON as the only source of project facts. Do not invent missing details. Omit them or use “On Request”. Do not use media or facts from a different project or city.';
  const prompt = `Create a complete, production-ready, responsive single-file HTML landing page for "${projectName}". Follow the LandingPageAgent skill below as a production checklist. Extract its useful requirements; do not show the skill or prompt text in the page. ${authority}

Use the current design brief for visual direction and exact palette. Do not replace its colors with a preset theme. Build a polished page with working interactions, semantic accessible HTML, CSS, and vanilla JavaScript. Return only the complete HTML document, beginning with <!doctype html> and ending with </html>. Do not use markdown fences.

<project_facts_json>\n${JSON.stringify(projectFacts, null, 2)}\n</project_facts_json>
<design_brief>\n${designBrief}\n</design_brief>
<specific_request>\n${request}\n</specific_request>
<landing_page_agent_skill>\n${skillInstructions}\n</landing_page_agent_skill>`;
  const models = [...new Set([preferredModel || 'gemini-2.5-flash', ...GEMINI_CANDIDATE_MODELS])];
  if (!apiKey) throw new Error('Connect a Gemini API key before selecting Gemini generation.');
  const stagingKey = path.resolve(stagingPath);
  if (activeLandingPageStagingPaths.has(stagingKey)) {
    throw new Error('A landing page request for this project is already running. Wait for it to finish before trying again.');
  }
  activeLandingPageStagingPaths.add(stagingKey);
  try {
    for (const model of models) {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(240000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 24576 }
        })
      });
      const responseText = await response.text();
      if (!response.ok) {
        let detail = responseText;
        try { detail = JSON.parse(responseText).error?.message || responseText; } catch (_) {}
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          throw new Error(`Gemini API error (${response.status}): ${detail}`);
        }
        console.warn(`[Gemini page generation] ${model} returned HTTP ${response.status}: ${detail}`);
        continue;
      }
      let data;
      try { data = JSON.parse(responseText); } catch (_) { throw new Error('Gemini returned an unreadable response.'); }
      const candidate = data.candidates?.[0];
      const html = cleanMarkdownHtml(candidate?.content?.parts?.map(part => part.text || '').join('\n') || '');
      if (!html) throw new Error(candidate?.finishReason === 'MAX_TOKENS'
        ? 'Gemini reached its output limit before finishing the page. Try a shorter design brief.'
        : 'Gemini returned no HTML page.');
      validateOpenCodeLandingPage(html, designBrief, projectName, projectFacts);
      fs.writeFileSync(stagingPath, html, 'utf8');
      return html;
    }
    throw new Error('Gemini could not generate the page with the available models. Check the API key and model access.');
  } finally {
    activeLandingPageStagingPaths.delete(stagingKey);
  }
}

function cleanMarkdownHtml(rawText) {
  let text = rawText.trim();
  // Remove markdown code fences ```html and ```
  if (text.startsWith('```html')) {
    text = text.substring(7);
  } else if (text.startsWith('```')) {
    text = text.substring(3);
  }

  if (text.endsWith('```')) {
    text = text.substring(0, text.length - 3);
  }
  return text.trim();
}

function runCodingAgent(prompt, cwd, timeoutMs = 600000, isComplete = () => false, getCompletionDiagnostic = () => null) {
  const agent = getCodingAgentConfig();
  if (agent.provider === 'opencode') {
    const serverUrl = (process.env.JUSTFLIP_OPENCODE_SERVER_URL || 'http://127.0.0.1:4096').replace(/\/$/, '');
    return (async () => {
      const healthResponse = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(1500) });
      if (!healthResponse.ok) throw new Error(`OpenCode server returned HTTP ${healthResponse.status}.`);

      const directoryQuery = `?directory=${encodeURIComponent(path.resolve(cwd))}`;
      const statusUrl = `${serverUrl}/session/status${directoryQuery}`;
      const sessionTitle = String(prompt.split(/\r?\n/, 1)[0] || 'Landing page generation').slice(0, 120);
      const createResponse = await fetch(`${serverUrl}/session${directoryQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: sessionTitle, agent: 'build' }),
        signal: AbortSignal.timeout(15000)
      });
      if (!createResponse.ok) throw new Error(`OpenCode could not start a fresh task (HTTP ${createResponse.status}).`);
      const session = await createResponse.json();
      if (!session?.id) throw new Error('OpenCode created a task without returning its session ID.');

      try {
        const selectResponse = await fetch(`${serverUrl}/tui/select-session${directoryQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionID: session.id }),
          signal: AbortSignal.timeout(10000)
        });
        if (!selectResponse.ok) {
          console.warn(`[OpenCode] Could not select session ${session.id} in the TUI (HTTP ${selectResponse.status}); continuing with the new OpenCode session.`);
        }
      } catch (error) {
        console.warn(`[OpenCode] Could not navigate the TUI to session ${session.id}: ${error.message}`);
      }

      const promptResponse = await fetch(`${serverUrl}/session/${encodeURIComponent(session.id)}/prompt_async${directoryQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
        signal: AbortSignal.timeout(15000)
      });
      if (!promptResponse.ok) throw new Error(`OpenCode could not start the landing page task (HTTP ${promptResponse.status}).`);

      const readSessionStatuses = async () => {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`OpenCode session status returned HTTP ${response.status}.`);
        const statuses = await response.json();
        if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
          throw new Error('OpenCode returned an invalid session status response.');
        }
        return statuses;
      };

      const deadline = Date.now() + timeoutMs;
      const sessionDetectionDeadline = Date.now() + 30000;
      let sawSessionBusy = false;
      let idleSince = 0;
      let consecutiveStatusTimeouts = 0;
      let repairPromptSent = false;
      let waitingForRepairActivity = false;
      let repairSubmittedAt = 0;
      while (Date.now() < deadline) {
        let statuses;
        try {
          statuses = await readSessionStatuses();
          consecutiveStatusTimeouts = 0;
        } catch (error) {
          if (error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error;
          consecutiveStatusTimeouts += 1;
          if (consecutiveStatusTimeouts >= 6) {
            throw new Error(`OpenCode task ${session.id} may still be running, but the dashboard could not read its status. Check the OpenCode window before retrying.`);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        if (statuses[session.id]?.type === 'busy') {
          sawSessionBusy = true;
          idleSince = 0;
          waitingForRepairActivity = false;
        } else if (sawSessionBusy) {
          if (waitingForRepairActivity) {
            if (isComplete()) return { stdout: `Completed in OpenCode session ${session.id} after a file-write repair.`, stderr: '' };
            if (Date.now() - repairSubmittedAt >= 30000) {
              throw new Error(`OpenCode accepted a repair request but did not resume session ${session.id}. Check that session in OpenCode before retrying.`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          idleSince = idleSince || Date.now();
          if (Date.now() - idleSince >= 2500) {
            if (isComplete()) return { stdout: `Completed in OpenCode session ${session.id}.`, stderr: '' };
            const diagnostic = getCompletionDiagnostic();
            if (diagnostic?.since && Date.now() - diagnostic.since >= 2500) {
              if (!repairPromptSent) {
                const repairMessage = `The dashboard checked the filesystem and found that your landing page output is still incomplete: ${diagnostic.message || 'the required HTML file is missing or invalid.'}\n\nResume the original task now. Use an available file-writing tool to create or repair the exact staging file requested in the original prompt. Do not only describe the page or claim it was written. Verify the file exists and is complete before finishing. Do not edit other files.`;
                const repairResponse = await fetch(`${serverUrl}/session/${encodeURIComponent(session.id)}/prompt_async${directoryQuery}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ parts: [{ type: 'text', text: repairMessage }] }),
                  signal: AbortSignal.timeout(15000)
                });
                if (!repairResponse.ok) throw new Error(`OpenCode could not start the automatic landing-page repair (HTTP ${repairResponse.status}).`);
                repairPromptSent = true;
                waitingForRepairActivity = true;
                repairSubmittedAt = Date.now();
                idleSince = 0;
                continue;
              }
              throw new Error(`OpenCode finished without creating a complete landing page after one automatic repair attempt: ${diagnostic.message || 'the HTML structure is invalid.'}`);
            }
            if (Date.now() - idleSince >= 10000) {
              throw new Error('OpenCode finished, but it did not leave a complete landing page file.');
            }
          }
        } else if (Date.now() >= sessionDetectionDeadline) {
          throw new Error(`The dashboard started OpenCode session ${session.id}, but it never reported as active. Check the OpenCode window before retrying.`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Connected OpenCode TUI did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
    })();
  }
  const args = agent.args.map(arg => arg.replace(/\{prompt\}/g, prompt));
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(agent.command, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (isComplete()) {
        settled = true;
        child.kill();
        resolve({ stdout, stderr, completedAfterTimeout: true });
        return;
      }
      child.kill();
      const output = (stderr || stdout).trim();
      reject(new Error(`Coding agent timed out after ${Math.round(timeoutMs / 1000)} seconds.${output ? ` Last output: ${output.slice(-1200)}` : ''}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      if (settled) return;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new Error(`Coding agent "${agent.provider}" (${agent.command}) was not found. Install it or set JUSTFLIP_CODING_AGENT_COMMAND.`));
      } else {
        reject(error);
      }
    });
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timer);
      const output = (stderr || stdout).trim();
      if (code !== 0 && /not recognized as an internal or external command|command not found/i.test(output)) {
        reject(new Error(`Coding agent "${agent.provider}" (${agent.command}) is not installed or not on PATH.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Coding agent exited with code ${code}: ${output.slice(-2000)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function callOpenCodeAI(prompt, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let output = '';
    let errOutput = '';
    const child = spawn('cmd.exe', ['/c', 'opencode.cmd', 'run', '--auto', '-m', 'google/gemini-2.5-flash'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      resolve({ success: false, reply: null, error: 'TIMEOUT' });
    }, timeoutMs);

    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { errOutput += chunk.toString(); });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ success: false, reply: null, error: err.message });
    });

    child.on('close', code => {
      clearTimeout(timer);
      const cleanReply = output.trim();
      if (cleanReply && cleanReply.length > 0) {
        resolve({ success: true, reply: cleanReply });
      } else {
        resolve({ success: false, reply: null, error: errOutput || `Exited with code ${code}` });
      }
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ success: false, reply: null, error: e.message });
    }
  });
}

function inlineUploadImages(htmlContent, publicDir) {
  if (!htmlContent) return htmlContent;
  return htmlContent.replace(/((?:['"]|&quot;|\(\s*)?)(?:\/)?uploads\/([^'"\)\s>&;]+)((?:['"]|&quot;|\s*\))?)/gi, (match, prefix, filename, suffix) => {
    try {
      const cleanName = filename.split('?')[0].split('#')[0];
      const filePath = path.join(publicDir, 'uploads', cleanName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(cleanName).toLowerCase().replace('.', '') || 'jpeg';
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
        const b64 = fs.readFileSync(filePath).toString('base64');
        const dataUri = `data:${mime};base64,${b64}`;
        return `${prefix}${dataUri}${suffix}`;
      }
    } catch (e) {
      console.warn('[Studio] Failed to inline image:', filename, e.message);
    }
    return match;
  });
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  console.log(`[HTTP ${req.method}] ${pathname}`);

  if (pathname.startsWith('/api/') && pathname !== '/api/auth-config') {
    try {
      let user = await getAuthenticatedSupabaseUser(req);
      if (!user) {
        const host = req.headers.host || '';
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.');
        if (isLocal) {
          user = { id: 'local-dev', email: 'developer@justflip.in', role: 'admin' };
        }
      }
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'AUTH_REQUIRED', message: 'A valid Supabase session is required.' }));
        return;
      }
      req.authenticatedUser = user;
    } catch (error) {
      console.error('[Auth] Supabase session validation failed:', error.message);
      const host = req.headers.host || '';
      const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.');
      if (isLocal) {
        req.authenticatedUser = { id: 'local-dev', email: 'developer@justflip.in', role: 'admin' };
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'AUTH_UNAVAILABLE', message: 'Authentication service is unavailable.' }));
        return;
      }
    }
  }

  if (req.method === 'GET' && pathname === '/api/auth-config') {
    const { url, anonKey } = getSupabaseAuthConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url, anonKey, googleEnabled: process.env.SUPABASE_GOOGLE_AUTH_ENABLED === 'true' }));
    return;
  }

  // API Endpoint: GET /api/settings
  if (req.method === 'GET' && pathname === '/api/settings') {
    const cfg = getConfig();
    const activeApiKey = cfg.apiKey || process.env.GEMINI_API_KEY || '';
    const activeOpenRouterKey = cfg.openRouterApiKey || process.env.OPENROUTER_API_KEY || '';
    const activeSupabaseKey = cfg.supabaseAnonKey || process.env.SUPABASE_ANON_KEY || '';
    const activeFirebaseKey = cfg.firebaseApiKey || process.env.FIREBASE_API_KEY || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hasApiKey: !!activeApiKey,
      maskedKey: activeApiKey ? `${activeApiKey.substring(0, 4)}...${activeApiKey.substring(activeApiKey.length - 4)}` : '',
      hasOpenRouterApiKey: !!activeOpenRouterKey,
      maskedOpenRouterKey: activeOpenRouterKey ? `${activeOpenRouterKey.substring(0, 8)}...${activeOpenRouterKey.substring(activeOpenRouterKey.length - 4)}` : '',
      openRouterModel: cfg.openRouterModel || 'openai/gpt-4o-mini',
      makeWebhookUrl: cfg.makeWebhookUrl || '',
      hasFirebase: !!(cfg.firebaseProjectId),
      firebaseProjectId: cfg.firebaseProjectId || '',
      maskedFirebaseKey: activeFirebaseKey ? `${activeFirebaseKey.substring(0, 6)}...${activeFirebaseKey.substring(activeFirebaseKey.length - 4)}` : '',
      hasSupabase: !!(cfg.supabaseUrl && activeSupabaseKey),
      supabaseUrl: cfg.supabaseUrl || '',
      maskedSupabaseKey: activeSupabaseKey ? `${activeSupabaseKey.substring(0, 6)}...${activeSupabaseKey.substring(activeSupabaseKey.length - 4)}` : ''
    }));
    return;
  }

  // API Endpoint: POST /api/settings
  if (req.method === 'POST' && pathname === '/api/settings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = getConfig();
        if (payload.clearApiKey) {
          cfg.apiKey = '';
        } else if (payload.apiKey !== undefined && payload.apiKey.trim() !== '') {
          cfg.apiKey = payload.apiKey.trim();
        }
        if (payload.openRouterApiKey !== undefined && payload.openRouterApiKey.trim() !== '') cfg.openRouterApiKey = payload.openRouterApiKey.trim();
        if (payload.clearOpenRouterApiKey) cfg.openRouterApiKey = '';
        if (payload.openRouterModel !== undefined && payload.openRouterModel.trim() !== '') cfg.openRouterModel = payload.openRouterModel.trim();
        if (payload.makeWebhookUrl !== undefined) cfg.makeWebhookUrl = payload.makeWebhookUrl.trim();
        if (payload.firebaseProjectId !== undefined) cfg.firebaseProjectId = payload.firebaseProjectId.trim();
        if (payload.firebaseApiKey !== undefined) cfg.firebaseApiKey = payload.firebaseApiKey.trim();
        if (payload.supabaseUrl !== undefined) cfg.supabaseUrl = payload.supabaseUrl.trim();
        if (payload.supabaseAnonKey !== undefined) cfg.supabaseAnonKey = payload.supabaseAnonKey.trim();
        saveConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Settings saved successfully' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

const GEMINI_CANDIDATE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-flash-latest'];

async function probeGeminiWithFallback(testKey) {
  let lastErr = '';
  for (const model of GEMINI_CANDIDATE_MODELS) {
    try {
      const probeUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const probeRes = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': testKey },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Respond with: PONG' }] }]
        })
      });
      if (probeRes.ok) {
        const probeData = await probeRes.json();
        const reply = probeData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'OK';
        return { success: true, model, reply };
      }
      const errData = await probeRes.text();
      let parsedErr = errData;
      try {
        const ej = JSON.parse(errData);
        parsedErr = ej.error?.message || errData;
      } catch(e) {}
      lastErr = `HTTP ${probeRes.status}: ${parsedErr}`;
      if (probeRes.status === 400 || probeRes.status === 403) {
        break;
      }
    } catch (err) {
      const cause = err.cause;
      lastErr = cause?.code
        ? `${cause.code}: ${cause.message || 'network request failed'}`
        : err.message;
    }
  }
  return { success: false, error: lastErr };
}

async function synthesizeContentWithGemini(formData, apiKey, preferredModel) {
  const modelsToTry = [preferredModel || 'gemini-2.5-flash', ...GEMINI_CANDIDATE_MODELS.filter(m => m !== (preferredModel || 'gemini-2.5-flash'))];
  
  const systemPrompt = `You are LandingPageAgent: Master real estate copywriter and conversion strategist for Justflip.
Given the property details and raw notes, synthesize bespoke high-converting luxury marketing copy.
Respond ONLY with a valid JSON object matching this exact schema:
{
  "heroEyebrow": "Short punchy badge (e.g. EXCLUSIVE PRE-LAUNCH IN NORTH BENGALURU)",
  "heroSubtitle": "Engaging subhead highlighting scale, units, open space and starting price",
  "editorialStory": "3 compelling paragraphs separated by double newlines (\\n\\n) detailing the architectural vision, biophilic layout, community lifestyle, and high rental/appreciation potential.",
  "overviewBullets": [
    "<b>Highlight 1 Title</b>: Compelling architectural highlight description",
    "<b>Highlight 2 Title</b>: Compelling landscape or community description",
    "<b>Highlight 3 Title</b>: Typologies and spatial planning description",
    "<b>Highlight 4 Title</b>: Lavish clubhouse and recreational sports description",
    "<b>Highlight 5 Title</b>: Strategic arterial connectivity and locational advantage"
  ],
  "statementQuote": "A memorable luxury pull-quote for the full-width visual break banner",
  "faqs": [
    { "q": "What are the apartment prices at the project?", "a": "Detailed answer explaining starting price, pricing tier by floor/tower, and requesting cost sheet." },
    { "q": "What configurations and sizes are available?", "a": "Detailed breakdown of typologies, carpet vs saleable areas." },
    { "q": "Where is the project located and what are the key commute times?", "a": "Precise location details with airport, arterial highways, and employment parks." },
    { "q": "Is the project RERA registered?", "a": "Statutory RERA registration confirmation and guidance." },
    { "q": "What lifestyle amenities are included?", "a": "Clubhouse, sports, green landscaping, and security features." },
    { "q": "How can I schedule a site visit or book an apartment?", "a": "Instructions on booking and site visit with zero brokerage." }
  ]
}`;

  const promptText = `Project Name: ${formData.projectName || 'Luxury Residences'}
Developer: ${formData.developerName || 'Premier Developer'}
Location: ${formData.location || 'Bengaluru'}
Starting Price: ${formData.price1bhk || formData.price || '₹65 Lakh*'}
Scale: ${formData.totalLand || '11.76 Acres'}, ${formData.towers || '9 Towers'}, ${formData.elevation || '3B+G+24 Floors'}, ${formData.totalUnits || '1,788 Units'}, ${formData.greenery || '75% Open Greens'}
Clubhouse: ${formData.clubhouseSize || '34,500 sq.ft'}
Raw Sales Notes / Context:
${formData.rawSalesNotes || formData.editorialStory || 'Luxury gated community with prime connectivity and premium lifestyle amenities.'}`;

  for (const model of modelsToTry) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4096,
            responseMimeType: "application/json"
          }
        })
      });

      if (res.ok) {
        const jsonRes = await res.json();
        const text = jsonRes.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          return { success: true, model, content: parsed };
        }
      } else {
        const errText = await res.text();
        console.warn(`[Studio] Gemini API HTTP ${res.status} for ${model}: ${errText}`);
      }
    } catch (e) {
      console.warn(`[Studio] Gemini synthesis attempt failed for ${model}:`, e.message);
    }
  }

  return { success: false, error: 'All Gemini candidate models failed' };
}

async function synthesizeContentWithOpenRouter(formData, apiKey, preferredModel) {
  const model = preferredModel || 'openai/gpt-4o-mini';
  const systemPrompt = `You are a real-estate landing page copywriter. Return ONLY valid JSON with these keys:
heroEyebrow, heroSubtitle, editorialStory, overviewBullets (array of strings), statementQuote,
faqs (array of objects with q and a). Never invent missing property facts; use "on request" when needed.`;
  const promptText = `Project: ${formData.projectName || 'Luxury Residences'}
Developer: ${formData.developerName || 'Premier Developer'}
Location: ${formData.location || 'Bengaluru'}
Price: ${formData.price1bhk || formData.price || 'On Request'}
Scale: ${formData.totalLand || ''}, ${formData.towers || ''}, ${formData.totalUnits || ''}, ${formData.greenery || ''}
Raw sales notes:
${formData.rawSalesNotes || formData.editorialStory || ''}`;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://justflip.in',
        'X-Title': 'Justflip Landing Page Studio'
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body;
      try { message = JSON.parse(body).error?.message || body; } catch (e) {}
      return { success: false, error: `HTTP ${res.status}: ${message}` };
    }
    const data = JSON.parse(body);
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { success: false, error: 'OpenRouter returned no content' };
    return { success: true, model, content: typeof content === 'string' ? JSON.parse(content) : content };
  } catch (error) {
    return { success: false, error: error.message };
  }
}


  // API Endpoint: POST /api/gemini/test (Test connection to Google Gemini API)
  if (req.method === 'POST' && pathname === '/api/gemini/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = getConfig();
        const testKey = (payload.apiKey || cfg.apiKey || process.env.GEMINI_API_KEY || '').trim();

        if (!testKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'No Gemini API key provided. Please paste your key from https://aistudio.google.com/app/apikey.'
          }));
          return;
        }

        const probeResult = await probeGeminiWithFallback(testKey);

        if (probeResult.success) {
          if (payload.saveOnSuccess && payload.apiKey) {
            cfg.apiKey = payload.apiKey.trim();
            cfg.geminiModel = probeResult.model;
            saveConfig(cfg);
          } else if (cfg.apiKey === testKey && probeResult.model) {
            cfg.geminiModel = probeResult.model;
            saveConfig(cfg);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            model: probeResult.model,
            maskedKey: `${testKey.substring(0, 4)}...${testKey.substring(testKey.length - 4)}`,
            message: `Connected successfully! Gemini model (${probeResult.model}) responded: "${probeResult.reply}". API is active and ready.`
          }));
        } else {
          let helpfulMsg = probeResult.error;
          if (helpfulMsg.includes('API_KEY_INVALID') || helpfulMsg.includes('API key not valid')) {
            helpfulMsg = 'Invalid API key. Please generate a valid Google Gemini key at https://aistudio.google.com/app/apikey (Google AI Studio keys start with AIzaSy).';
          }
          const networkFailure = /\bfetch failed\b|\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)\b|network request failed/i.test(helpfulMsg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            code: networkFailure ? 'GEMINI_NETWORK_ERROR' : 'GEMINI_CONNECTION_ERROR',
            message: helpfulMsg
          }));
        }
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: `Connection failed: ${err.message}`
        }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/openrouter/test (Test OpenRouter connection)
  if (req.method === 'POST' && pathname === '/api/openrouter/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = getConfig();
        const apiKey = (payload.apiKey || cfg.openRouterApiKey || process.env.OPENROUTER_API_KEY || '').trim();
        const model = (payload.model || cfg.openRouterModel || 'openai/gpt-4o-mini').trim();
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'No OpenRouter API key provided.' }));
          return;
        }
        const probe = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://justflip.in',
            'X-Title': 'Justflip Landing Page Studio'
          },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
            max_tokens: 8
          })
        });
        const text = await probe.text();
        if (!probe.ok) {
          let message = text;
          try { message = JSON.parse(text).error?.message || text; } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: `HTTP ${probe.status}: ${message}` }));
          return;
        }
        if (payload.saveOnSuccess && payload.apiKey) {
          cfg.openRouterApiKey = apiKey;
          cfg.openRouterModel = model;
          saveConfig(cfg);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, model }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: `Connection failed: ${err.message}` }));
      }
    });
    return;
  }

  // API Endpoint: GET /api/firebase/rules.txt (View / Download Firestore Security Rules)
  if (req.method === 'GET' && pathname === '/api/firebase/rules.txt') {
    const rulesPath = path.join(DATA_DIR, 'firebase_rules.txt');
    if (fs.existsSync(rulesPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(rulesPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rules file not found' }));
    }
    return;
  }

  // API Endpoint: POST /api/firebase/test (Test connection to Firebase Project)
  if (req.method === 'POST' && pathname === '/api/firebase/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = getConfig();
        const projectId = (payload.firebaseProjectId || payload.projectId || cfg.firebaseProjectId || '').trim();
        const apiKey = (payload.firebaseApiKey || payload.apiKey || cfg.firebaseApiKey || '').trim();

        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Firebase Project ID is required.' }));
          return;
        }

        const queryParts = ['pageSize=1'];
        if (apiKey) queryParts.push(`key=${apiKey}`);
        const testUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/sites?${queryParts.join('&')}`;
        const testRes = await fetch(testUrl);

        if (testRes.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Firebase Firestore connected successfully to project "${projectId}"! Collections are ready.`
          }));
        } else {
          const errText = await testRes.text();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: `Firebase returned HTTP ${testRes.status}: ${errText}. Please check the project ID and ensure Firestore Database is created in your Firebase Console.`
          }));
        }
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Connection failed: ' + err.message }));
      }
    });
    return;
  }

  // API Endpoint: GET /api/supabase/schema.sql (Download / View SQL migration script)
  if (req.method === 'GET' && pathname === '/api/supabase/schema.sql') {
    if (fs.existsSync(SUPABASE_SQL_FILE)) {
      const sql = fs.readFileSync(SUPABASE_SQL_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(sql);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Schema file not found' }));
    }
    return;
  }

  // API Endpoint: POST /api/supabase/test (Test connection to Supabase Project)
  if (req.method === 'POST' && pathname === '/api/supabase/test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = getConfig();
        const url = (payload.supabaseUrl || cfg.supabaseUrl || '').trim();
        const key = (payload.supabaseAnonKey || cfg.supabaseAnonKey || '').trim();

        if (!url || !key) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Supabase Project URL and Anon API Key are required.' }));
          return;
        }

        const baseUrl = normalizeSupabaseUrl(url);
        const testUrl = `${baseUrl}/rest/v1/sites?select=site_id&limit=1`;
        const testRes = await fetch(testUrl, {
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`
          }
        });

        if (testRes.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Supabase cloud connection verified! Sites and Leads tables are ready.'
          }));
        } else {
          const errText = await testRes.text();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: `Supabase returned HTTP ${testRes.status}: ${errText}. Ensure the schema SQL has been executed in the Supabase SQL Editor.`
          }));
        }
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Connection failed: ' + err.message }));
      }
    });
    return;
  }

  // API Endpoint: GET /api/sites (Registry of live landing pages)
  if (req.method === 'GET' && pathname === '/api/sites') {
    const cfg = getConfig();
    let sites = null;
    let source = 'local';

    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
      sites = await fetchSitesFromSupabase(cfg);
      if (sites) source = 'supabase';
    } else if (cfg.firebaseProjectId) {
      sites = await fetchSitesFromFirebase(cfg);
      if (sites) source = 'firebase';
    }

    if (!sites || sites.length === 0) {
      sites = getLocalSites();
      source = 'local';
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      sites: sites,
      totalSites: sites.length,
      source: source,
      supabaseConfigured: !!(cfg.supabaseUrl && cfg.supabaseAnonKey),
      firebaseConfigured: !!(cfg.firebaseProjectId)
    }));
    return;
  }

  // API Endpoint: POST /api/sites (Register or update site status/url)
  if (req.method === 'POST' && pathname === '/api/sites') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.site_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'site_id is required' }));
          return;
        }
        registerOrUpdateSite(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Site registered successfully' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: /api/leads (Disabled)
  if (pathname === '/api/leads') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, leads: [], total: 0 }));
    return;
  }

  // API Endpoint: POST /api/upload (Handle Image & Document Uploads)
  if (req.method === 'POST' && pathname === '/api/upload') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const fileName = (payload.name || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '_');
        const timestamp = Date.now();
        const finalName = `${timestamp}_${fileName}`;
        const uploadDir = path.join(PUBLIC_DIR, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        // Strip data:image/...;base64,
        let base64Data = payload.data || '';
        if (base64Data.includes(',')) {
          base64Data = base64Data.split(',')[1];
        }

        const buffer = Buffer.from(base64Data, 'base64');
        const filePath = path.join(uploadDir, finalName);
        fs.writeFileSync(filePath, buffer);

        console.log(`[Studio Upload] Saved image: ${finalName} (${buffer.length} bytes)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          url: `/uploads/${finalName}`,
          fileName: finalName,
          type: payload.type || 'gallery'
        }));
      } catch (err) {
        console.error('[Studio Upload Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/generate-landing-page (The Live AI Synthesizer)
  if (req.method === 'POST' && pathname === '/api/coding-agent/generate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const formData = JSON.parse(body || '{}');
        const projectName = String(formData.projectName || 'Luxury Residences');
        const slug = String(formData.siteId || projectName)
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'luxury-residences';
        const outputDir = path.join(GENERATED_DIR, slug);
        fs.mkdirSync(outputDir, { recursive: true });
        const generatedPath = path.join(outputDir, 'index.html');
        const safePayload = { ...formData };
        delete safePayload.apiKey;
        delete safePayload.openRouterApiKey;
        delete safePayload.geminiModel;
        delete safePayload.openRouterModel;

        const requestPath = path.join(outputDir, 'coding-agent-request.json');
        const assetDir = path.join(outputDir, 'assets');
        if (!fs.existsSync(assetDir)) fs.mkdirSync(assetDir, { recursive: true });
        const chatAssets = Array.isArray(formData.chatAttachments) ? formData.chatAttachments : [];
        const copiedAssets = chatAssets.map((asset, index) => {
          const assetUrl = String(asset.url || '');
          if (!assetUrl.startsWith('/uploads/')) return { ...asset, localPath: '', relativePath: '' };
          const sourceName = path.basename(assetUrl);
          const sourcePath = path.join(PUBLIC_DIR, 'uploads', sourceName);
          if (!fs.existsSync(sourcePath)) return { ...asset, localPath: '', relativePath: '' };
          const targetName = `${String(index + 1).padStart(2, '0')}-${sourceName}`;
          const targetPath = path.join(assetDir, targetName);
          fs.copyFileSync(sourcePath, targetPath);
          return {
            ...asset,
            localPath: targetPath,
            relativePath: `assets/${targetName}`,
            publicUrl: `/generated/${slug}/assets/${targetName}`
          };
        });
        safePayload.chatAttachments = copiedAssets;
        fs.writeFileSync(requestPath, JSON.stringify(safePayload, null, 2), 'utf8');

        // Pre-build guaranteed 20-section landing page immediately
        try {
          const prebuiltHtml = generatorTemplate.buildFullLandingPage(safePayload);
          fs.writeFileSync(generatedPath, prebuiltHtml, 'utf8');
        } catch (genErr) {
          console.warn('[Coding Agent] Pre-render warning:', genErr.message);
        }

        const generationStartedAt = Date.now();
        const prompt = `You are customizing a production-ready real-estate landing page for Justflip.
An initial complete 20-section HTML page is already generated at "${generatedPath}".
Read the project brief at "${requestPath}".
You are running in a Windows PowerShell environment: DO NOT execute bash syntax (such as 2>/dev/null, ||, or ls -la).
Refine "${generatedPath}" with project-specific styling, copy, and layout adjustments based on the brief.
Ensure "${generatedPath}" remains a complete standalone HTML document.`;

        try {
          const agent = getCodingAgentConfig();
          console.log(`[Coding Agent] Refining ${slug} with ${agent.provider} (${agent.command})`);
          await runCodingAgent(
            prompt,
            process.cwd(),
            90000,
            () => fs.existsSync(generatedPath)
              && fs.statSync(generatedPath).size >= 1000
              && fs.statSync(generatedPath).mtimeMs >= generationStartedAt
          );
        } catch (agentErr) {
          console.warn(`[Coding Agent] Agent refinement notice (${agentErr.message}). Serving pre-rendered 20-section page.`);
        }

        if (!fs.existsSync(generatedPath) || fs.statSync(generatedPath).size < 1000) {
          const fallbackHtml = generatorTemplate.buildFullLandingPage(safePayload);
          fs.writeFileSync(generatedPath, fallbackHtml, 'utf8');
        }

        const createdAt = new Date().toISOString();
        fs.writeFileSync(path.join(outputDir, 'generation-meta.json'), JSON.stringify({
          projectId: slug,
          createdAt,
          outputFile: `generated/${slug}/index.html`
        }, null, 2), 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          projectId: slug,
          previewUrl: `/generated/${slug}/index.html`,
          createdAt,
          message: `Landing page generated for ${slug}`
        }));
      } catch (error) {
        console.error('[Coding Agent Error]', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

const THEME_PALETTES = {
  'emerald-gold': {
    ink: '#0f1c16',
    indigo: '#0f3826',
    indigoDeep: '#082418',
    indigoNight: '#051910',
    royal: '#1a4d36',
    gold: '#d4af37',
    goldSoft: '#e2c76e',
    goldBright: '#f1dc96',
    goldInk: '#997a15',
    cream: '#f4f8f4',
    cream2: '#e5eee5',
    lineGold: 'rgba(212,175,55,.45)'
  },
  'forest-bronze': {
    ink: '#1a201c',
    indigo: '#1b382b',
    indigoDeep: '#11241b',
    indigoNight: '#0a1711',
    royal: '#244c3b',
    gold: '#b88351',
    goldSoft: '#cfa175',
    goldBright: '#e3be97',
    goldInk: '#7d532b',
    cream: '#f6f7f3',
    cream2: '#ebece3',
    lineGold: 'rgba(184,131,81,.45)'
  },
  'royal-silver': {
    ink: '#111827',
    indigo: '#1e293b',
    indigoDeep: '#0f172a',
    indigoNight: '#070d18',
    royal: '#2563eb',
    gold: '#38bdf8',
    goldSoft: '#7dd3fc',
    goldBright: '#bae6fd',
    goldInk: '#0284c7',
    cream: '#f8fafc',
    cream2: '#f1f5f9',
    lineGold: 'rgba(56,189,248,.45)'
  },
  'obsidian-luxury': {
    ink: '#171717',
    indigo: '#1f1f1f',
    indigoDeep: '#141414',
    indigoNight: '#0a0a0a',
    royal: '#2a2a2a',
    gold: '#d4a373',
    goldSoft: '#e3bc95',
    goldBright: '#f0d4b8',
    goldInk: '#8f6036',
    cream: '#faf8f5',
    cream2: '#f0ebe1',
    lineGold: 'rgba(212,163,115,.45)'
  },
  'navy-gold': {
    ink: '#121826',
    indigo: '#0f2547',
    indigoDeep: '#0b1c38',
    indigoNight: '#06122a',
    royal: '#1b3a66',
    gold: '#c6a45e',
    goldSoft: '#d8bd7c',
    goldBright: '#e9cf8a',
    goldInk: '#8a6a2a',
    cream: '#f7f3ea',
    cream2: '#efe8d8',
    lineGold: 'rgba(198,164,94,.45)'
  }
};

function applySmartHtmlEdit(html, message) {
  let updated = html;
  const msg = message.toLowerCase();

  // 1. Literal replacement: "change 'X' to 'Y'" or "replace 'X' with 'Y'"
  const literalMatch = message.match(/(?:replace|change)\s+["'“]([^"'”]+)["'”]\s+(?:to|with)\s+["'“]([^"'”]+)["'”]/i);
  if (literalMatch) {
    const oldText = literalMatch[1];
    const newText = literalMatch[2];
    updated = updated.split(oldText).join(newText);
  }

  // 2. Price updates: e.g. "change price to 1.85 Cr", "pricing to 2.1 Cr"
  const priceMatches = message.match(/(?:[₹?]|&#8377;|Rs\.?|\bINR\b)*\s*(\d+(?:\.\d+)?)\s*(Cr|Lakhs?|L)\*?/gi);
  if (priceMatches && priceMatches.length > 0) {
    let targetPrice = priceMatches[priceMatches.length - 1].trim();
    if (!targetPrice.startsWith('₹') && !targetPrice.toLowerCase().startsWith('rs') && !targetPrice.startsWith('&#8377;')) {
      targetPrice = `₹${targetPrice}`;
    }
    if (!targetPrice.endsWith('*')) targetPrice += '*';
    updated = updated.replace(/(?:[₹?]|&#8377;|Rs\.?)\s*\d+(?:\.\d+)?\s*(?:Cr|Lakhs?)\*?/gi, targetPrice);
    updated = updated.replace(/(<div class="hp-val">)([^<]+)(<\/div>)/i, `$1${targetPrice}$3`);
  }

  // 3. Headline updates
  const quoteMatch = message.match(/["']([^"']{5,})["']/);
  if (quoteMatch && (msg.includes('headline') || msg.includes('title') || msg.includes('hero'))) {
    const newHeadline = quoteMatch[1].trim();
    updated = updated.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, `$1${newHeadline}$3`);
  } else if ((msg.includes('headline') || msg.includes('hero') || msg.includes('title')) && (msg.includes('lakeside') || msg.includes('lake'))) {
    updated = updated.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, '$1Prestige Parklane <span class="gold">Luxury Lakeside Living · Aerospace Park</span>$3');
  } else if ((msg.includes('headline') || msg.includes('hero') || msg.includes('title')) && (msg.includes('punchier') || msg.includes('bolder') || msg.includes('exclusive'))) {
    updated = updated.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, '$1Prestige Parklane <span class="gold">Exclusive High-Rise Luxury at Aerospace Park</span>$3');
  }

  // 4. Subtitle / Tagline: e.g. "change subtitle to ..."
  const subMatch = message.match(/(?:subtitle|tagline|eyebrow)\s+to\s+["':]?\s*([^"'\n\r]+)["']?/i);
  if (subMatch && subMatch[1].trim().length > 3) {
    const newSub = subMatch[1].trim().replace(/^["']|["']$/g, '');
    updated = updated.replace(/(<p[^>]*class="[^"]*hero-sub[^"]*"[^>]*>)([\s\S]*?)(<\/p>)/i, `$1${newSub}$3`);
  }

  // 5. Color Theme tweaks via CSS Variables
  let targetTheme = null;
  if (msg.includes('emerald') || msg.includes('green')) targetTheme = 'emerald-gold';
  else if (msg.includes('forest') || msg.includes('bronze')) targetTheme = 'forest-bronze';
  else if (msg.includes('royal') || msg.includes('silver')) targetTheme = 'royal-silver';
  else if (msg.includes('obsidian') || msg.includes('black')) targetTheme = 'obsidian-luxury';
  else if (msg.includes('navy') || msg.includes('blue')) targetTheme = 'navy-gold';

  if (targetTheme && THEME_PALETTES[targetTheme]) {
    const p = THEME_PALETTES[targetTheme];
    updated = updated.replace(/--ink:[^;]+;/g, `--ink:${p.ink};`)
                     .replace(/--indigo:[^;]+;/g, `--indigo:${p.indigo};`)
                     .replace(/--indigo-deep:[^;]+;/g, `--indigo-deep:${p.indigoDeep};`)
                     .replace(/--indigo-night:[^;]+;/g, `--indigo-night:${p.indigoNight};`)
                     .replace(/--royal:[^;]+;/g, `--royal:${p.royal};`)
                     .replace(/--gold:[^;]+;/g, `--gold:${p.gold};`)
                     .replace(/--gold-soft:[^;]+;/g, `--gold-soft:${p.goldSoft};`)
                     .replace(/--gold-bright:[^;]+;/g, `--gold-bright:${p.goldBright};`)
                     .replace(/--gold-ink:[^;]+;/g, `--gold-ink:${p.goldInk};`)
                     .replace(/--cream:[^;]+;/g, `--cream:${p.cream};`)
                     .replace(/--cream-2:[^;]+;/g, `--cream-2:${p.cream2};`)
                     .replace(/--line-gold:[^;]+;/g, `--line-gold:${p.lineGold};`);
  }

  // 6. Phone / WhatsApp updates
  const phoneMatch = message.match(/(?:phone|whatsapp|contact|mobile|call)\s+(?:to\s+)?(\+?\d[\d\s-]{8,}\d)/i);
  if (phoneMatch) {
    const newPhone = phoneMatch[1].replace(/[\s-]/g, '');
    updated = updated.replace(/(?:tel:|wa\.me\/|href="tel:)\+?\d+/gi, (match) => {
      if (match.startsWith('href="tel:')) return `href="tel:${newPhone}`;
      if (match.startsWith('tel:')) return `tel:${newPhone}`;
      if (match.startsWith('wa.me/')) return `wa.me/${newPhone}`;
      return match;
    });
  }

  // 7. Amenity Additions
  if ((msg.includes('pool') || msg.includes('swimming') || msg.includes('squash')) && !updated.includes('Olympic-Size Lap Pool')) {
    if (updated.includes('class="amen-tags"')) {
      updated = updated.replace(/(<div class="amen-tags"[^>]*>)/i, `$1<span>Olympic-Size Lap Pool</span><span>Indoor Squash Court</span>`);
    } else if (updated.includes('class="amen-grid"')) {
      const newAmenity = `
      <div class="amen-card" style="padding:1.25rem;border-radius:1rem;background:var(--paper);border:1px solid var(--line);display:flex;align-items:flex-start;gap:1rem;">
        <div style="width:2.5rem;height:2.5rem;border-radius:.75rem;background:rgba(212,175,55,.15);color:var(--gold-ink);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.3rem;">
          🏊
        </div>
        <div>
          <h4 style="font-weight:700;color:var(--ink);font-size:.9rem;margin:0;">Olympic-Length Lap Pool &amp; Squash Court</h4>
          <p style="font-size:.78rem;color:var(--muted);margin:.25rem 0 0 0;">Temperature-controlled lap pool with expansive sundeck and international-standard indoor squash courts.</p>
        </div>
      </div>`;
      updated = updated.replace(/(<div class="amen-grid"[^>]*>)/i, `$1\n${newAmenity}`);
    }
  }

  // 8. Developer / Builder update
  const devMatch = message.match(/(?:developer|builder)\s+(?:to\s+|is\s+|name\s+to\s+)?["']?([A-Za-z0-9\s.,&-]{3,35})["']?$/i);
  if (devMatch && (msg.includes('developer') || msg.includes('builder'))) {
    const newDev = devMatch[1].trim();
    updated = updated.replace(/(<span[^>]*class="[^"]*brand-name[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/i, `$1${newDev}$3`);
  }

  // 9. Location update
  const locMatch = message.match(/(?:location|address)\s+to\s+["']?([A-Za-z0-9\s.,&-]{3,40})["']?/i);
  if (locMatch) {
    const newLoc = locMatch[1].trim();
    updated = updated.replace(/(<span[^>]*class="[^"]*loc-badge[^"]*"[^>]*>)([\s\S]*?)(<\/span>)/i, `$1📍 ${newLoc}$3`);
  }

  return updated;
}

function isEditIntent(message) {
  const msg = message.toLowerCase().trim();
  const pureConversational = /^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|yo|sup|help|who\s+are\s+you|what\s+can\s+you\s+do|how\s+are\s+you)\b/i;
  if (pureConversational.test(msg) && !msg.includes('change') && !msg.includes('update') && !msg.includes('make') && !msg.includes('price')) {
    return false;
  }
  const editKeywords = [
    'change', 'update', 'modify', 'replace', 'set', 'make', 'tweak', 'edit',
    'price', 'pricing', 'cr', 'lakh', 'cost',
    'theme', 'color', 'emerald', 'forest', 'royal', 'obsidian', 'navy', 'gold', 'blue', 'green',
    'headline', 'title', 'hero', 'subtitle', 'tagline', 'eyebrow',
    'phone', 'whatsapp', 'contact', 'mobile', 'call', 'number',
    'amenity', 'amenities', 'pool', 'gym', 'clubhouse', 'squash', 'court',
    'developer', 'builder', 'location', 'bengaluru', 'aerospace', 'commute',
    'floor plan', 'master plan', 'spec', 'specifications', 'rera',
    'add', 'remove', 'delete'
  ];
  return editKeywords.some(kw => msg.includes(kw));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function isValidTheme(theme) {
  if (!theme || typeof theme !== 'string') return false;
  const t = theme.trim().toLowerCase();
  if (/^(d apartments|specifications|on request|numbers|name|details|floor plans|apartments|luxury|amenities|true|false)$/i.test(t)) return false;
  if (/#([a-fA-F0-9]{6})/i.test(t)) return true;
  const validKeywords = [
    'navy-gold', 'emerald-gold', 'forest-bronze', 'royal-silver', 
    'sapphire-gold', 'terracotta-warm', 'rose-gold-noir', 'slate-azure', 
    'burgundy-champagne', 'obsidian-luxury', 'emerald', 'forest', 'bronze', 
    'terracotta', 'sapphire', 'azure', 'burgundy', 'obsidian', 'silver', 
    'navy', 'gold', 'blue', 'green', 'black', 'rose', 'champagne', 'charcoal',
    'graphite', 'tuscan', 'amber', 'platinum', 'cyan', 'teal'
  ];
  return validKeywords.some(k => t.includes(k));
}

function isValidFontStyle(font) {
  if (!font || typeof font !== 'string') return false;
  const f = font.trim().toLowerCase();
  if (/^(d apartments|specifications|on request|numbers|name|details|floor plans|apartments|luxury|amenities|true|false)$/i.test(f)) return false;
  const valid = [
    'playfair-montserrat', 'cormorant-garamond', 'cinzel-raleway',
    'plus-jakarta-sans', 'inter', 'outfit', 'poppins', 'dm-sans',
    'space-grotesk', 'lora-roboto'
  ];
  return valid.some(v => f.includes(v)) || f.includes('sans') || f.includes('serif') || f.includes('display');
}

// Canonical W3C Named Colors Dictionary
const W3C_NAMED_COLORS = {
  aliceblue: '#F0F8FF', antiquewhite: '#FAEBD7', aqua: '#00FFFF', aquamarine: '#7FFFD4',
  azure: '#F0FFFF', beige: '#F5F5DC', bisque: '#FFE4C4', black: '#000000',
  blanchedalmond: '#FFEBCD', blue: '#0000FF', blueviolet: '#8A2BE2', brown: '#A52A2A',
  burlywood: '#DEB887', cadetblue: '#5F9EA0', chartreuse: '#7FFF00', chocolate: '#D2691E',
  coral: '#FF7F50', cornflowerblue: '#6495ED', cornsilk: '#FFF8DC', crimson: '#DC143C',
  cyan: '#00FFFF', darkblue: '#00008B', darkcyan: '#008B8B', darkgoldenrod: '#B8860B',
  darkgray: '#A9A9A9', darkgrey: '#A9A9A9', darkgreen: '#006400', darkkhaki: '#BDB76B',
  darkmagenta: '#8B008B', darkolivegreen: '#556B2F', darkorange: '#FF8C00', darkorchid: '#9932CC',
  darkred: '#8B0000', darksalmon: '#E9967A', darkseagreen: '#8FBC8F', darkslateblue: '#483D8B',
  darkslategray: '#2F4F4F', darkslategrey: '#2F4F4F', darkturquoise: '#00CED1', darkviolet: '#9400D3',
  deeppink: '#FF1493', deepskyblue: '#00BFFF', dimgray: '#696969', dimgrey: '#696969',
  dodgerblue: '#1E90FF', firebrick: '#B22222', floralwhite: '#FFFAF0', forestgreen: '#228B22',
  fuchsia: '#FF00FF', gainsboro: '#DCDCDC', ghostwhite: '#F8F8FF', gold: '#FFD700',
  goldenrod: '#DAA520', gray: '#808080', grey: '#808080', green: '#008000',
  greenyellow: '#ADFF2F', honeydew: '#F0FFF0', hotpink: '#FF69B4', indianred: '#CD5C5C',
  indigo: '#4B0082', ivory: '#FFFFF0', khaki: '#F0E68C', lavender: '#E6E6FA',
  lavenderblush: '#FFF0F5', lawngreen: '#7CFC00', lemonchiffon: '#FFFACD', lightblue: '#ADD8E6',
  lightcoral: '#F08080', lightcyan: '#E0FFFF', lightgoldenrodyellow: '#FAFAD2', lightgray: '#D3D3D3',
  lightgrey: '#D3D3D3', lightgreen: '#90EE90', lightpink: '#FFB6C1', lightsalmon: '#FFA07A',
  lightseagreen: '#20B2AA', lightskyblue: '#87CEFA', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#B0C4DE', lightyellow: '#FFFFE0', lime: '#00FF00', limegreen: '#32CD32',
  linen: '#FAF0E6', magenta: '#FF00FF', maroon: '#800000', mediumaquamarine: '#66CDAA',
  mediumblue: '#0000CD', mediumorchid: '#BA55D3', mediumpurple: '#9370DB', mediumseagreen: '#3CB371',
  mediumslateblue: '#7B68EE', mediumspringgreen: '#00FA9A', mediumturquoise: '#48D1CC', mediumvioletred: '#C71585',
  midnightblue: '#191970', mintcream: '#F5FFFA', mistyrose: '#FFE4E1', moccasin: '#FFE4B5',
  navajowhite: '#FFDEAD', navy: '#000080', oldlace: '#FDF5E6', olive: '#808000',
  olivedrab: '#6B8E23', orange: '#FFA500', orangered: '#FF4500', orchid: '#DA70D6',
  palegoldenrod: '#EEE8AA', palegreen: '#98FB98', paleturquoise: '#AFEEEE', palevioletred: '#DB7093',
  papayawhip: '#FFEFD5', peachpuff: '#FFDAB9', peru: '#CD853F', pink: '#FFC0CB',
  plum: '#DDA0DD', powderblue: '#B0E0E6', purple: '#800080', rebeccapurple: '#663399',
  red: '#FF0000', rosybrown: '#BC8F8F', royalblue: '#4169E1', saddlebrown: '#8B4513',
  salmon: '#FA8072', sandybrown: '#F4A460', seagreen: '#2E8B57', seashell: '#FFF5EE',
  sienna: '#A0522D', silver: '#C0C0C0', skyblue: '#87CEEB', slateblue: '#6A5ACD',
  slategray: '#708090', slategrey: '#708090', snow: '#FFFAFA', springgreen: '#00FF7F',
  steelblue: '#4682B4', tan: '#D2B48C', teal: '#008080', thistle: '#D8BFD8',
  tomato: '#FF6347', turquoise: '#40E0D0', violet: '#EE82EE', wheat: '#F5DEB3',
  white: '#FFFFFF', whitesmoke: '#F5F5F5', yellow: '#FFFF00', yellowgreen: '#9ACD32'
};

function resolveNamedColorToHex(colorName) {
  if (!colorName || typeof colorName !== 'string') return null;
  const clean = colorName.toLowerCase().replace(/[^a-z]/g, '');
  return W3C_NAMED_COLORS[clean] || null;
}

function extractThemeObjectFromText(text) {
  if (!text) return null;
  const pMatch = text.match(/Primary\s*Color\s*[:=-]\s*(#[0-9a-fA-F]{6})/i);
  const sMatch = text.match(/Secondary\s*Color\s*[:=-]\s*(#[0-9a-fA-F]{6})/i);
  const aMatch = text.match(/Accent\s*Color\s*[:=-]\s*(#[0-9a-fA-F]{6})/i);
  const bMatch = text.match(/Background\s*Color\s*[:=-]\s*(#[0-9a-fA-F]{6})/i);
  const tMatch = text.match(/Text\s*Color\s*[:=-]\s*(#[0-9a-fA-F]{6})/i);

  if (pMatch) {
    return {
      primaryColor: pMatch[1],
      secondaryColor: sMatch ? sMatch[1] : '#C5A059',
      accentColor: aMatch ? aMatch[1] : (sMatch ? sMatch[1] : '#F5D061'),
      backgroundColor: bMatch ? bMatch[1] : '#FFFFFF',
      textColor: tMatch ? tMatch[1] : '#0F172A',
      surfaceColor: '#F8FAFC'
    };
  }
  return null;
}

function detectNamedColorsInText(text) {
  if (!text) return [];
  // Strict intent guard: Only parse named colors if there is an explicit color/theme command
  // or a short message (< 120 chars) explicitly talking about colors.
  // NEVER scan 300+ character project descriptions for "green" or "gold" or "navy"!
  const hasColorIntent = /(?:color(?:s)?|theme|palette|shade|background|navbar|accent)\s*(?:to|is|as|=|:)?\s*([a-z\s-]+)/i.test(text) ||
                        /(?:use|make\s+it|switch\s+to|change\s+to|apply|give\s+me)\s+([a-z\s-]+)\s+(?:color|theme|palette)/i.test(text);

  if (!hasColorIntent && text.length > 120) {
    return [];
  }

  const found = [];
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const seenHex = new Set();

  for (let i = 0; i < words.length; i++) {
    // 3-word check (e.g. "light golden rod yellow", "medium sea green")
    if (i + 2 < words.length) {
      const w3 = words[i] + words[i+1] + words[i+2];
      if (W3C_NAMED_COLORS[w3]) {
        const hex = W3C_NAMED_COLORS[w3];
        if (!seenHex.has(hex)) {
          found.push({ name: `${words[i]} ${words[i+1]} ${words[i+2]}`, hex });
          seenHex.add(hex);
        }
        i += 2;
        continue;
      }
    }
    // 2-word check (e.g. "midnight blue", "alice blue", "forest green", "dark golden rod")
    if (i + 1 < words.length) {
      const w2 = words[i] + words[i+1];
      if (W3C_NAMED_COLORS[w2]) {
        const hex = W3C_NAMED_COLORS[w2];
        if (!seenHex.has(hex)) {
          found.push({ name: `${words[i]} ${words[i+1]}`, hex });
          seenHex.add(hex);
        }
        i += 1;
        continue;
      }
    }
    // 1-word check
    const w1 = words[i];
    if (W3C_NAMED_COLORS[w1]) {
      const commonWords = ['tan', 'linen', 'snow', 'green', 'gold', 'blue', 'red', 'dark', 'coral', 'plum'];
      if (!commonWords.includes(w1) || hasColorIntent) {
        const hex = W3C_NAMED_COLORS[w1];
        if (!seenHex.has(hex)) {
          found.push({ name: w1, hex });
          seenHex.add(hex);
        }
      }
    }
  }
  return found;
}

function extractColorThemeFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // 1. Check for explicit Section 7 Theme & Color Tokens or Primary Color: #RRGGBB
  const obj = extractThemeObjectFromText(text);
  if (obj) {
    return `${obj.primaryColor} ${obj.secondaryColor}`;
  }

  // 2. Check for explicit hex codes e.g. #1b382b or #003366
  const hexMatches = text.match(/#[a-fA-F0-9]{6}\b/g);
  if (hexMatches && hexMatches.length > 0) {
    const parenMatch = text.match(/\(([^)]*#[a-fA-F0-9]{6}[^)]*)\)/);
    if (parenMatch) return parenMatch[1].trim();
    return hexMatches.join(' ');
  }

  // 3. Check for intentional W3C named colors
  const detectedNamed = detectNamedColorsInText(text);
  if (detectedNamed.length >= 2) {
    return `${detectedNamed[0].hex} ${detectedNamed[1].hex}`;
  } else if (detectedNamed.length === 1) {
    return detectedNamed[0].hex;
  }

  // 4. Explicit theme/color commands
  const themeMatch = t.match(/(?:color(?:s)?|theme|palette)\s*(?:to|is|as|=|:)?\s*([a-z\s-]+)/i) ||
                     t.match(/(?:use|make\s+it|switch\s+to|change\s+to|apply)\s+([a-z\s-]+)\s+(?:color|theme|palette)/i);

  if (themeMatch && themeMatch[1]) {
    const raw = themeMatch[1].trim().toLowerCase();
    if (raw.includes('emerald') || raw.includes('mint') || raw.includes('green')) return 'emerald-gold';
    if (raw.includes('forest') || raw.includes('pine') || raw.includes('earth') || raw.includes('bronze')) return 'forest-bronze';
    if (raw.includes('terracotta') || raw.includes('tuscan') || raw.includes('clay') || raw.includes('orange') || raw.includes('sand') || raw.includes('rust')) return 'terracotta-warm';
    if (raw.includes('rose') || raw.includes('pink') || raw.includes('plum')) return 'rose-gold-noir';
    if (raw.includes('burgundy') || raw.includes('wine') || raw.includes('maroon') || raw.includes('red') || raw.includes('crimson')) return 'burgundy-champagne';
    if (raw.includes('slate') || raw.includes('azure') || raw.includes('cyan') || raw.includes('teal')) return 'slate-azure';
    if (raw.includes('silver') || raw.includes('platinum')) return 'royal-silver';
    if (raw.includes('obsidian') || raw.includes('black') || raw.includes('dark') || raw.includes('charcoal') || raw.includes('graphite') || raw.includes('noir')) return 'obsidian-luxury';
    if (raw.includes('sapphire') || (raw.includes('royal') && raw.includes('blue')) || raw.includes('cobalt')) return 'sapphire-gold';
    if (raw.includes('navy') || raw.includes('gold')) return 'navy-gold';
    if (raw.length >= 3 && !/^(the|a|an|new|different|some|any|this|that|d apartments|specifications)$/.test(raw)) return raw;
  }

  // Direct mentions of color names anywhere in prompt
  if (t.includes('terracotta') || t.includes('tuscan') || t.includes('clay')) return 'terracotta-warm';
  if (t.includes('rose gold') || t.includes('rosegold')) return 'rose-gold-noir';
  if (t.includes('slate azure') || t.includes('slate blue')) return 'slate-azure';
  if (t.includes('burgundy') || t.includes('wine color') || t.includes('wine theme') || t.includes('maroon')) return 'burgundy-champagne';
  if (t.includes('obsidian') || t.includes('black gold') || t.includes('noir theme') || t.includes('charcoal')) return 'obsidian-luxury';
  if (t.includes('sapphire') || t.includes('cobalt')) return 'sapphire-gold';
  if (t.includes('royal silver') || t.includes('silver sky')) return 'royal-silver';
  if (t.includes('forest bronze') || t.includes('forest green') || t.includes('forest') || t.includes('bronze') || t.includes('biophilic')) return 'forest-bronze';
  if (t.includes('emerald')) return 'emerald-gold';
  if (t.includes('navy gold') || t.includes('midnight navy')) return 'navy-gold';

  return null;
}

function pickDistinctTheme(text = '', name = '', location = '') {
  const combined = (name + ' ' + location + ' ' + text).toLowerCase();
  
  if (combined.includes('eco') || combined.includes('green') || combined.includes('nature') || combined.includes('park') || combined.includes('garden')) {
    return 'emerald-gold';
  }
  if (combined.includes('villa') || combined.includes('estate') || combined.includes('resort') || combined.includes('countryside') || combined.includes('earth')) {
    return 'terracotta-warm';
  }
  if (combined.includes('tech') || combined.includes('airport') || combined.includes('aerospace') || combined.includes('cyber') || combined.includes('smart')) {
    return 'slate-azure';
  }
  if (combined.includes('palace') || combined.includes('regal') || combined.includes('heights') || combined.includes('towers') || combined.includes('sky')) {
    return 'sapphire-gold';
  }
  if (combined.includes('boutique') || combined.includes('suites') || combined.includes('penthouse') || combined.includes('exclusive')) {
    return 'rose-gold-noir';
  }
  if (combined.includes('modern') || combined.includes('minimal') || combined.includes('noir') || combined.includes('glass')) {
    return 'obsidian-luxury';
  }
  if (combined.includes('woods') || combined.includes('hills') || combined.includes('valley') || combined.includes('forest')) {
    return 'forest-bronze';
  }
  if (combined.includes('heritage') || combined.includes('manor') || combined.includes('imperial') || combined.includes('vintage')) {
    return 'burgundy-champagne';
  }

  const palettes = [
    'emerald-gold',
    'royal-silver',
    'terracotta-warm',
    'sapphire-gold',
    'forest-bronze',
    'slate-azure',
    'rose-gold-noir',
    'obsidian-luxury',
    'burgundy-champagne',
    'navy-gold'
  ];
  let hash = 0;
  for (let i = 0; i < (name || 'justflip').length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palettes[hash % palettes.length];
}

function extractFontStyleFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const fontRequestRegex = /(?:font(?:-family|s)?|typography|type)\s*(?:style)?\s*(?:to|as|is|=|:)?\s*['"]?([a-zA-Z\s-]+)['"]?/i;
  const fontRequestRegex2 = /(?:use|switch\s+to|change\s+to|make\s+it)\s+['"]?([a-zA-Z\s-]+)['"]?\s+font/i;
  const fontMatch = text.match(fontRequestRegex) || text.match(fontRequestRegex2);
  if (fontMatch && fontMatch[1]) {
    const rawFont = fontMatch[1].trim();
    if (rawFont.length >= 3 && !/^(the|a|an|new|different|some|any|this|that)$/i.test(rawFont)) {
      return rawFont;
    }
  }
  if (t.includes('plus jakarta') || t.includes('jakarta')) return 'plus-jakarta-sans';
  if (t.includes('cormorant') || t.includes('garamond')) return 'cormorant-garamond';
  if (t.includes('inter')) return 'inter';
  if (t.includes('poppins')) return 'poppins';
  if (t.includes('outfit')) return 'outfit';
  if (t.includes('cinzel')) return 'cinzel-raleway';
  if (t.includes('lora')) return 'lora-roboto';
  if (t.includes('space grotesk') || t.includes('grotesk')) return 'space-grotesk';
  if (t.includes('dm sans')) return 'dm-sans';
  if (t.includes('playfair')) return 'playfair-montserrat';
  return null;
}

function getOrInitBlueprint(slug, projectName, intakeData) {
  const bpPath = path.join(GENERATED_DIR, slug, 'chat-blueprint.json');
  if (fs.existsSync(bpPath)) {
    try {
      const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
      if (intakeData?.heroImage && (!bp.heroImage || bp.heroImage.includes('prestige-constructions') || intakeData.heroImage !== bp.heroImage)) {
        bp.heroImage = intakeData.heroImage;
      }
      if (Array.isArray(intakeData?.galleryImages) && intakeData.galleryImages.length > 0) {
        bp.galleryImages = intakeData.galleryImages;
      }
      if (Array.isArray(intakeData?.floorPlanImages) && intakeData.floorPlanImages.length > 0) {
        bp.floorPlanImages = intakeData.floorPlanImages;
      }
      if (Array.isArray(intakeData?.overviewImages) && intakeData.overviewImages.length > 0) {
        bp.overviewImages = intakeData.overviewImages;
      }
      if (intakeData?.brochureImage1) bp.brochureImage1 = intakeData.brochureImage1;
      if (intakeData?.brochureImage2) bp.brochureImage2 = intakeData.brochureImage2;
      if (intakeData?.brochureImage3) bp.brochureImage3 = intakeData.brochureImage3;
      if (intakeData?.locationMapImage) bp.locationMapImage = intakeData.locationMapImage;
      if (intakeData?.greenBannerImage) bp.greenBannerImage = intakeData.greenBannerImage;
      if (intakeData?.tourBackgroundImage) bp.tourBackgroundImage = intakeData.tourBackgroundImage;
      ['gal1', 'gal2', 'gal3', 'gal4', 'gal5', 'gal6'].forEach(k => {
        if (intakeData?.[k]) bp[k] = intakeData[k];
      });
      if (Array.isArray(intakeData?.lifeAtImages) && intakeData.lifeAtImages.length > 0) {
        bp.lifeAtImages = intakeData.lifeAtImages;
      }
      return bp;
    } catch (e) {}
  }
  const selectedThemeKey = intakeData?.selectedThemeKey || DEFAULT_THEME_KEY;
  const curPalette = getThemePalette(selectedThemeKey);
  const customGals = Array.isArray(intakeData?.galleryImages) ? intakeData.galleryImages.filter(u => u && !u.includes('prestige-constructions') && !u.includes('prestige-parklane')) : [];
  const customHero = (intakeData?.heroImage && !intakeData.heroImage.includes('prestige-constructions') && !intakeData.heroImage.includes('prestige-parklane')) ? intakeData.heroImage : (customGals[0] || null);

  const defaultBp = {
    slug,
    projectName: projectName || 'Prestige Parklane',
    developerName: intakeData?.developerName || 'Prestige Group',
    location: intakeData?.location || 'KIADB Aerospace Park · Devanahalli, Bengaluru',
    selectedThemeKey,
    brandTheme: selectedThemeKey,
    theme: {
      primaryColor: curPalette.primary,
      secondaryColor: curPalette.secondary,
      accentColor: curPalette.accent,
      backgroundColor: curPalette.bg,
      textColor: curPalette.text,
      surfaceColor: curPalette.surface
    },

    fontStyle: intakeData?.fontStyle || 'playfair-montserrat',
    heroImage: customHero || intakeData?.heroImage || null,
    overviewImages: Array.isArray(intakeData?.overviewImages) && intakeData.overviewImages.length > 0 ? intakeData.overviewImages : [
      intakeData?.overviewImage || customHero || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-garden.jpg',
      intakeData?.greenBannerImage || customGals[1] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-dusk.jpg',
      customHero || intakeData?.heroImage || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg',
      intakeData?.gal4 || customGals[2] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/pool-fountain.jpg'
    ],
    brochureImage1: intakeData?.brochureImage1 || intakeData?.brochureImage || customGals[1] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/brochure-cover.jpg',
    brochureImage2: intakeData?.brochureImage2 || customGals[2] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/brochure-plans-cover.jpg',
    brochureImage3: intakeData?.brochureImage3 || customGals[3] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/garden-walk.jpg',
    locationMapImage: intakeData?.locationMapImage || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/location-map.jpg',
    greenBannerImage: intakeData?.greenBannerImage || intakeData?.statementBannerImage || customGals[2] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-dusk.jpg',
    tourBackgroundImage: intakeData?.tourBackgroundImage || customHero || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg',
    gal1: intakeData?.gal1 || customGals[0] || customHero || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-garden.jpg',
    gal2: intakeData?.gal2 || customGals[1] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg',
    gal3: intakeData?.gal3 || customGals[2] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-dusk.jpg',
    gal4: intakeData?.gal4 || customGals[3] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/pool-fountain.jpg',
    gal5: intakeData?.gal5 || customGals[4] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/garden-walk.jpg',
    gal6: intakeData?.gal6 || customGals[5] || 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/pool-evening.jpg',
    lifeAtImages: Array.isArray(intakeData?.lifeAtImages) ? intakeData.lifeAtImages : [],
    galleryImages: customGals.length > 0 ? customGals : (Array.isArray(intakeData?.galleryImages) ? intakeData.galleryImages : []),
    floorPlanImages: Array.isArray(intakeData?.floorPlanImages) ? intakeData.floorPlanImages : [],
    price: intakeData?.price || intakeData?.price1bhk || '₹1.85 Cr*',
    startingPrice: intakeData?.price || '₹1.85 Cr*',
    price1bhk: intakeData?.price1bhk || '₹1.85 Cr*',
    price2bhk: intakeData?.price2bhk || 'On Request*',
    price3bhk: intakeData?.price3bhk || 'On Request*',
    totalLand: intakeData?.totalLand || '11.76 Acres',
    towers: intakeData?.towers || '9 Towers',
    elevation: intakeData?.elevation || '3B + G + 24 Floors',
    totalUnits: intakeData?.totalUnits || '1,788 Apartments',
    greenery: intakeData?.greenery || '75% Open & Green Space',
    clubhouseSize: intakeData?.clubhouseSize || '~34,500 sq ft',
    configurationsText: intakeData?.configurationsText || '1, 2 & 3 BHK Luxury Suites',
    projectStatus: intakeData?.projectStatus || 'New Launch (Phase 1)',
    phone: intakeData?.phone || '+91 93423 33197',
    whatsapp: intakeData?.whatsapp || '+91 74116 62228',
    reraId: intakeData?.reraId || 'PRM/KA/RERA/1251/309/PR/150926/008941',
    heroEyebrow: intakeData?.heroEyebrow || '⭐ EXCLUSIVE PRE-LAUNCH IN NORTH BENGALURU',
    heroHeadline: intakeData?.heroHeadline || `${projectName || 'Prestige Parklane'} — Luxury High-Rise Living`,
    heroSubtitle: intakeData?.heroSubtitle || 'Master-planned luxury residential enclave with open green panoramas, signature clubhouse, and aerospace tech corridor connectivity.',
    editorialStory: intakeData?.editorialStory || 'Experience refined architectural luxury in North Bengaluru, engineered for biophilic tranquility and strategic connectivity.',
    amenities: [
      'Olympic-Length Lap Pool',
      'Indoor Squash Courts',
      'Signature Clubhouse (~34,500 sq ft)',
      'Tennis & Pickleball Courts',
      'Reflexology Pathway',
      'Fully Equipped Fitness Center'
    ],
    commute: [
      { name: "Kempegowda Int'l Airport", time: '15 mins / 20 km' },
      { name: 'Manyata Tech Park', time: '20 mins / 18 km' },
      { name: 'Aerospace SEZ Gate', time: '2 mins' }
    ],
    typologies: [
      { name: '1 BHK Luxury', area: '567 - 571 sq ft', carpet: '323 sq ft', price: '₹1.85 Cr* Onwards' },
      { name: '2 BHK Premium', area: '828 - 880 sq ft', carpet: '512 sq ft', price: 'On Request*' },
      { name: '2 BHK Large', area: '1,087 - 1,103 sq ft', carpet: '685 sq ft', price: 'On Request*' },
      { name: '3 BHK 2T Royal', area: '1,445 - 1,469 sq ft', carpet: '915 sq ft', price: 'On Request*' },
      { name: '3 BHK 3T Luxury', area: '1,597 - 1,662 sq ft', carpet: '1,045 sq ft', price: 'On Request*' },
      { name: '3 BHK 3T Large', area: '1,757 - 1,801 sq ft', carpet: '1,148 sq ft', price: 'On Request*' }
    ],
    status: 'blueprint',
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(bpPath, JSON.stringify(defaultBp, null, 2), 'utf8');
  return defaultBp;
}

function extractFreshBlueprintFromText(text, fallbackSlug) {
  const clean = String(text || '').trim();

  // Detect Region / City
  let detectedCity = 'New Delhi';
  if (/kochi|cochin|ernakulam|marine drive/i.test(clean)) detectedCity = 'Kochi';
  else if (/mangaluru|mangalore|kadri/i.test(clean)) detectedCity = 'Mangalore';
  else if (/mumbai|worli|bandra|mahalaxmi|thane/i.test(clean)) detectedCity = 'Mumbai';
  else if (/chennai|omr|ecr|kotturpuram|anna nagar|tamil nadu/i.test(clean)) detectedCity = 'Chennai';
  else if (/delhi|ncr|moti nagar|okhla|gurgaon|gurugram|noida|shivaji marg/i.test(clean)) detectedCity = 'New Delhi';
  else if (/bengaluru|bangalore|whitefield|devanahalli|bellary/i.test(clean)) detectedCity = 'Bengaluru';

  // 1. Project Name
  let projectName = '';
  const titleMatch = clean.match(/(?:Project\s+Name|Property\s+Name)\s*[:=-]\s*["']?([^"\n\r,]+)/i)
    || clean.match(/Primary\s+H1\s*[:=-]\s*([^—–\n\r|]+)/i)
    || clean.match(/for\s+["']([^"'\n\r]+)["']/i);
  if (titleMatch) {
    projectName = (titleMatch[1] || titleMatch[0]).split(/\r?\n/)[0].trim();
    projectName = projectName.replace(/^[#*_\s=—–-]+|[#*_\s=—–-]+$/g, '').trim();
    if (projectName.toLowerCase().startsWith('prompt')) {
      const sub = clean.match(/for\s+["']([^"'\n\r]+)["']/i);
      if (sub) projectName = sub[1].trim();
    }
  }
  if (!projectName || projectName.length < 3 || projectName.toLowerCase().includes('prompt')) {
    const forMatch = clean.match(/for\s+["']([^"'\n\r]+)["']/i);
    if (forMatch) projectName = forMatch[1].trim();
    else projectName = 'Luxury Residences';
  }

  // 2. Developer Name
  let developerName = '';
  const devMatch = clean.match(/(?:Developer\s+Brand|Developer|Builder|Promoter)\s*[:=-]\s*([^\n\r(]+)/i);
  if (devMatch) {
    developerName = devMatch[1].split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');
  }
  if (!developerName || developerName.toLowerCase() === 'brand') {
    developerName = 'Premier Developer';
  }

  // 3. Location / Micro-Market
  let location = '';
  const locMatch = clean.match(/(?:Micro-Market|Site\s+Location|Location|Address)\s*[:=-]\s*([^\n\r(]+)/i);
  if (locMatch) {
    location = locMatch[1].split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');
  }
  if (!location || location === 'Bengaluru') {
    location = detectedCity;
  }

  // 4. Land Area
  let totalLand = '5.5 Acres';
  const landMatch = clean.match(/(?:Land\s+Parcel(?:\s*&\s*Scale)?|Total\s+Land(?:\s*Area)?)\s*[:=-]\s*([^\n\r|]+)/i)
    || clean.match(/(\d+(?:\.\d+)?)\s*[- ]?(?:acre|acres)/i);
  if (landMatch) {
    totalLand = (landMatch[1] || landMatch[0]).split(/\r?\n/)[0].trim();
    if (!totalLand.toLowerCase().includes('acre')) totalLand += ' Acres';
  }

  // 5. Open Space / Greenery
  let greenery = '80% Open Greens & Landscaping';
  const greenMatch = clean.match(/(?:Green\s+Buffer|Greenery|Open\s+Space)\s*[:=-]\s*([^\n\r|]+)/i)
    || clean.match(/(\d+)\s*(?:percent|%)\s*(?:left\s*wide\s*open|open|green)/i);
  if (greenMatch) {
    greenery = (greenMatch[1] || greenMatch[0]).split(/\r?\n/)[0].trim();
  }

  // 6. RERA ID
  let reraId = 'PRM/KA/RERA/1257/334/PR/180625/007850';
  const reraMatch = clean.match(/(?:State\s+RERA\s+ID|RERA\s+Registration|RERA(?:\s*No\.?|\s*Registration|\s*ID)?)\s*[:=-]?\s*([A-Za-z0-9\/\-_]+)/i);
  if (reraMatch) {
    reraId = reraMatch[1].trim();
  } else if (/[A-Z]{2,6}(?:\/[A-Z]{2})?\/RERA\/[A-Za-z0-9\/\-_]+/i.test(clean)) {
    reraId = clean.match(/[A-Z]{2,6}(?:\/[A-Z]{2})?\/RERA\/[A-Za-z0-9\/\-_]+/i)[0];
  }

  // 7. Phone & Contact
  let phone = '+91 98450 82465';
  const phoneMatch = clean.match(/(?:call\s*us|tel|phone|contact|Helpline)\s*[:=-]?\s*(\+?\d[\d\s-]{8,}\d)/i);
  if (phoneMatch) {
    phone = phoneMatch[1].trim();
  }

  let whatsapp = '919845082465';
  const waMatch = clean.match(/(?:WhatsApp|wa)\s*[:=-]?\s*(\+?\d[\d\s-]{8,}\d)/i);
  if (waMatch) {
    whatsapp = waMatch[1].replace(/[^0-9]/g, '');
  }

  // 8. Starting Price
  let price = 'Price on Request*';
  const priceMatch = clean.match(/(?:Starting\s+Price\s+Hook|Starting\s+Price|Price)\s*[:=-]\s*([^\n\r|]+)/i)
    || clean.match(/(₹\s*\d+(?:\.\d+)?\s*(?:Cr|Crore|Lakh|Lakhs)\*?(?:\s*Onwards)?)/i);
  if (priceMatch) {
    price = (priceMatch[1] || priceMatch[0]).split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');
  }

  // 9. Scale & Master Metrics
  let towers = '2 Iconic Sky Towers';
  const towerMatch = clean.match(/(?:Towers?(?:\s*&\s*Elevation)?|Elevation\s*&\s*Towers?)\s*[:=-]\s*([^\n\r|]+)/i);
  if (towerMatch) towers = towerMatch[1].split(/\r?\n/)[0].trim();

  let elevation = 'Palatial Coastal High-Rise';
  const elevMatch = clean.match(/(?:Elevation)\s*[:=-]\s*([^\n\r|]+)/i);
  if (elevMatch) elevation = elevMatch[1].split(/\r?\n/)[0].trim();

  let totalUnits = 'Exclusive Luxury Residences';
  const unitsMatch = clean.match(/(?:Total\s+Residences|Total\s+Units|Units)\s*[:=-]\s*([^\n\r|]+)/i);
  if (unitsMatch) totalUnits = unitsMatch[1].split(/\r?\n/)[0].trim();

  let clubhouseSize = 'Grand Lifestyle Club & Spa Pavilion';
  const clubMatch = clean.match(/(?:Clubhouse[^\n\r:]*)\s*[:=-]\s*([^\n\r|]+)/i);
  if (clubMatch) clubhouseSize = clubMatch[1].split(/\r?\n/)[0].trim();

  let configurationsText = '2, 3 & 4 BHK Luxury Suites';
  const configMatch = clean.match(/(?:Configurations?)\s*[:=-]\s*([^\n\r|]+)/i);
  if (configMatch) configurationsText = configMatch[1].split(/\r?\n/)[0].trim();

  // 10. Hero Eyebrow, Headline, Subtitle
  let heroEyebrow = `⭐ EXCLUSIVE LUXURY LIVING IN ${detectedCity.toUpperCase()}`;
  if (clean.includes('⭐')) {
    const starMatch = clean.match(/⭐\s*([^\n\r]+)/);
    if (starMatch) heroEyebrow = `⭐ ${starMatch[1].split(/\r?\n/)[0].trim()}`;
  }
  const ebMatch = clean.match(/(?:Pre-Headline|Hero\s+Eyebrow|Eyebrow)\s*[:=-]\s*([^\n\r]+)/i);
  if (ebMatch) heroEyebrow = ebMatch[1].split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');

  let heroHeadline = `${projectName} — Coastal Luxury & Master-Planned Living`;
  const hlMatch = clean.match(/(?:Primary\s+H1|Hero\s+Headline|Headline)\s*[:=-]\s*([^\n\r]+)/i);
  if (hlMatch) heroHeadline = hlMatch[1].split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');

  let heroSubtitle = `An exclusive residential enclave in ${location} featuring panoramic views, signature clubhouse, and world-class amenities.`;
  const subMatch = clean.match(/(?:Sub-Headline|Hero\s+Subtitle|Subtitle)\s*[:=-]\s*([^\n\r]+)/i);
  if (subMatch) heroSubtitle = subMatch[1].split(/\r?\n/)[0].trim().replace(/^[#*_\s•-]+|[#*_\s•-]+$/g, '');

  // 11. Editorial Story
  const storyParas = [];
  const p1 = clean.match(/Paragraph\s*1[^:]*:\s*([^\n\r]+)/i);
  const p2 = clean.match(/Paragraph\s*2[^:]*:\s*([^\n\r]+)/i);
  const p3 = clean.match(/Paragraph\s*3[^:]*:\s*([^\n\r]+)/i);
  if (p1) storyParas.push(p1[1].trim());
  if (p2) storyParas.push(p2[1].trim());
  if (p3) storyParas.push(p3[1].trim());

  const editorialStory = storyParas.length > 0 
    ? storyParas.join('\n\n') 
    : `Rising gracefully in ${location}, ${projectName} redefines architectural luxury in ${detectedCity}. Developed by ${developerName}, this landmark enclave balances pristine biophilic landscaping with world-class residential comforts.\n\nEvery home is crafted with oversized viewing balconies, cross-ventilating breezy layouts, and premium specifications designed for discerning families and global investors.\n\nLife revolves around an exclusive lifestyle clubhouse featuring resort swimming pools, wellness spa pavilions, sports arenas, and 24/7 five-tier security for absolute peace of mind.`;

  // 12. Typologies
  const typologies = [];
  const typoRegex = /[•*-]\s*(\d+\s*BHK[^\n\r:]*):\s*([^|\n\r]+)(?:\|\s*([^|\n\r]+))?(?:\|\s*([^\n\r]+))?/gi;
  let tMatch;
  while ((tMatch = typoRegex.exec(clean)) !== null) {
    const name = tMatch[1].trim();
    const area = tMatch[2].trim();
    const priceStr = tMatch[3] ? tMatch[3].trim() : price;
    const desc = tMatch[4] ? tMatch[4].trim() : 'Spacious master layout with panoramic exterior views and premium finishes.';
    typologies.push({ name, area, carpet: area.split('(')[1]?.replace(')', '') || area, price: priceStr, description: desc });
  }
  if (typologies.length === 0) {
    typologies.push(
      { name: '2 BHK Luxury Sky Suite', area: '2,125 sq.ft.', carpet: '1,520 sq.ft.', price: price, description: 'Private entrance foyer, Italian marble, and ocean-facing sundeck.' },
      { name: '3 BHK Royal Residence', area: '2,745 sq.ft.', carpet: '1,960 sq.ft.', price: price, description: 'Dual-aspect balconies, en-suite bedrooms, and maid quarters.' },
      { name: '4 BHK Imperial Penthouse', area: '3,350 sq.ft.', carpet: '2,420 sq.ft.', price: price, description: '3-side open layout, double-height living, and private terrace provision.' }
    );
  }

  // 13. Commute
  const commute = [];
  const commSection = clean.match(/(?:Commute|Connectivity)[^:]*:\s*([\s\S]*?)(?=(?:\d+\.\s+[A-Z]|Editorial|Theme|Pricing|Amenities|$))/i);
  if (commSection) {
    const commLines = commSection[1].split(/\r?\n/);
    for (const cl of commLines) {
      const m = cl.match(/[•*-]?\s*([^:–—]+?)\s*[:–—]\s*([^\n\r]+)/);
      if (m && !m[1].toLowerCase().includes('category') && m[1].length > 3) {
        commute.push({ name: m[1].replace(/^[•*-]\s*/, '').trim(), time: m[2].trim() });
      }
    }
  }
  if (commute.length === 0) {
    const commRegex = /[•*-]\s*([A-Za-z0-9\s/(),&'.-]+(?:Campus|Beach|Lighthouse|Stations?|Airport|Place|Enclave|Secretariat|High\s*Streets?|Toll|Flyover|Junction|Hub|Road|CBD)):\s*([^\n\r]+)/gi;
    let cMatch;
    while ((cMatch = commRegex.exec(clean)) !== null) {
      commute.push({ name: cMatch[1].trim(), time: cMatch[2].trim() });
    }
  }
  if (commute.length === 0) {
    commute.push(
      { name: 'NH 66 Coastal Express Corridor', time: '2 Mins' },
      { name: 'Transit & Railway Hub', time: '5 Mins' },
      { name: 'City Centre & Commercial CBD', time: '15 Mins' },
      { name: 'International Airport Corridor', time: '20 Mins' }
    );
  }

  // 14. Amenities
  const amenities = [];
  const amSection = clean.match(/(?:Master\s+Amenities|Amenities|Lifestyle)[^:]*:\s*([\s\S]*?)(?=(?:\d+\.\s+[A-Z]|Commute|Connectivity|Editorial|Theme|Pricing|$))/i);
  if (amSection) {
    const lines = amSection[1].split(/\r?\n/).map(l => l.replace(/^[•*-]\s*/, '').trim()).filter(l => l.length > 5 && !l.startsWith('Category') && !l.startsWith('Paragraph'));
    if (lines.length > 0) amenities.push(...lines.slice(0, 10));
  }
  if (amenities.length === 0) {
    amenities.push(
      'Olympic-Length Swimming Pool & Sunken Cabanas',
      '50,000 sq.ft. Multi-Level Clubhouse & Spa Pavilion',
      'Rooftop Sky Lounge & Panoramic Viewing Observatory',
      'Indoor Squash & Badminton Arena',
      '100% DG Power Backup for Full Residential Load',
      '5-Tier Biometric & AI Video Surveillance Security'
    );
  }

  // 15. Theme & Colors (Curated Theme Registry Tokens)
  let selectedThemeKey = DEFAULT_THEME_KEY;
  if (/marine|waterfront|sea|beach|coastal|lake|backwater|ocean|port|azure/i.test(clean)) {
    selectedThemeKey = 'coastal-azure';
  } else if (/biophilic|green|forest|eco|garden|park|nature|canopy|emerald/i.test(clean)) {
    selectedThemeKey = 'emerald-gold';
  } else {
    selectedThemeKey = 'obsidian-silver';
  }
  const curPalette = getThemePalette(selectedThemeKey);
  const theme = {
    primaryColor: curPalette.primary,
    secondaryColor: curPalette.secondary,
    accentColor: curPalette.accent,
    backgroundColor: curPalette.bg,
    textColor: curPalette.text,
    surfaceColor: curPalette.surface
  };

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallbackSlug || 'luxury-residences';

  return {
    slug,
    projectName,
    developerName,
    location,
    selectedThemeKey,
    brandTheme: selectedThemeKey,
    theme,
    fontStyle: 'playfair-montserrat',
    price,
    startingPrice: price,
    price1bhk: price,
    price2bhk: typologies[1]?.price || price,
    price3bhk: typologies[2]?.price || price,
    totalLand,
    towers,
    elevation,
    totalUnits,
    greenery,
    clubhouseSize,
    configurationsText,
    projectStatus: 'Under Construction & Limited New Launch',
    phone,
    whatsapp,
    reraId,
    heroEyebrow,
    heroHeadline,
    heroSubtitle,
    editorialStory,
    amenities,
    commute,
    faqs: [
      { question: `What is the exact location and RERA approval for ${projectName}?`, answer: `${projectName} is nestled at ${location}. It is registered under state RERA registration number ${reraId}.` },
      { question: `What configurations and starting prices are available?`, answer: `${projectName} features ${configurationsText} starting from ${price}.` },
      { question: `What signature amenities and recreational facilities are provided?`, answer: `Residents enjoy ${amenities.slice(0, 3).join(', ')}, and ${amenities[3] || 'round-the-clock concierge services'}.` },
      { question: `Who is the developer and promoter on record?`, answer: `${projectName} is developed by ${developerName}, a premier builder known for quality architectural engineering and transparent escrow compliance.` }
    ],
    typologies,
    status: 'blueprint',
    updatedAt: new Date().toISOString()
  };
}

function updateBlueprintFromMessage(bp, message) {
  const msg = message.toLowerCase();

  // Price updates - require contextual keywords to avoid false matches
  const priceMatches = message.match(/(?:starting\s*(?:at|from)?|price|cost|launch\s*price|from)\s*[:=-]?\s*(?:[₹?]|&#8377;|Rs\.?|\bINR\b)?\s*(\d+(?:\.\d+)?\s*(?:Cr|Lakhs?|L))\*?/gi);
  if (priceMatches && priceMatches.length > 0) {
    let p = priceMatches[priceMatches.length - 1].trim();
    const cleanNum = p.match(/(\d+(?:\.\d+)?\s*(?:Cr|Lakhs?|L))/i);
    if (cleanNum) {
      let finalPrice = `₹${cleanNum[1].trim()}`;
      if (!finalPrice.endsWith('*')) finalPrice += '*';
      bp.price = finalPrice;
      bp.startingPrice = finalPrice;
      bp.price1bhk = finalPrice;
      if (bp.typologies && bp.typologies[0]) {
        bp.typologies[0].price = `${finalPrice} Onwards`;
      }
    }
  }

  // Developer updates
  const devMatch = message.match(/(?:developed\s*by|developer|builder|promoter)\s*[:=-]?\s*([A-Za-z0-9 .,&-]{3,45})/i) ||
                   message.match(/\b(Rohan|Land Trades|Sattva|Godrej|Prestige|Sobha|Brigade|Puravankara|Lodha|DLF|Tata|Isprava|Salarpuria)\s*(?:Corporation|Group|Properties|Limited|Estates|Builders)?\b/i);
  if (devMatch) {
    bp.developerName = (devMatch[1] || devMatch[0]).split(/\r?\n/)[0].trim();
  }

  // Project Name updates
  const projMatch = message.match(/(?:project\s+name|rename\s+to|property\s+name)\s*[:=-]?\s*([A-Za-z0-9 .,&-]{3,45})/i);
  if (projMatch) {
    bp.projectName = (projMatch[1] || projMatch[0]).split(/\r?\n/)[0].trim();
  }

  // Location updates (strictly exclude bare 'area' so Land Area is never captured as Location)
  const locMatch = message.match(/(?:location|address)\s+to\s+["']?([A-Za-z0-9 .,&-]{3,50})["']?/i) ||
                   message.match(/(?:micro-market|project\s+location|site\s+address|location|address)\s*[:=-]\s*([^\n\r,;]+)/i);
  if (locMatch) {
    bp.location = locMatch[1].split(/\r?\n/)[0].trim();
  }

  // Land area & scale updates
  const landMatch = message.match(/(?:land(?:\s*area)?|acreage|acres?)\s*[:=-]?\s*(\d+(?:\.\d+)?\s*(?:Acres?|Gunthas?))/i);
  if (landMatch) bp.totalLand = landMatch[1].trim();

  const towersMatch = message.match(/(?:towers?|elevations?)\s*[:=-]?\s*(\d+\s*Towers?)/i);
  if (towersMatch) bp.towers = towersMatch[1].trim();

  const unitsMatch = message.match(/(?:units?|apartments?|residences?)\s*[:=-]?\s*([\d,]+\s*Units?)/i);
  if (unitsMatch) bp.totalUnits = unitsMatch[1].trim();

  const reraMatch = message.match(/(?:rera(?:\s*(?:id|no|number|reg))?)\s*[:=-]\s*([A-Za-z0-9\/\-_]+)/i);
  if (reraMatch) bp.reraId = reraMatch[1].trim();

  // W3C Named Colors & Theme updates
  const explicitThemeObj = extractThemeObjectFromText(message);
  if (explicitThemeObj) {
    bp.theme = explicitThemeObj;
    bp.brandTheme = `${explicitThemeObj.primaryColor} ${explicitThemeObj.secondaryColor}`;
  } else {
    const namedColors = detectNamedColorsInText(message);
    if (namedColors.length > 0) {
      if (!bp.theme) bp.theme = {};
      bp.theme.primaryColor = namedColors[0].hex;
      if (namedColors.length >= 2) {
        bp.theme.secondaryColor = namedColors[1].hex;
      }
      bp.brandTheme = `${namedColors[0].hex} ${namedColors[1]?.hex || bp.theme.secondaryColor || '#C5A059'}`;
    } else if (/\b(?:theme|palette|colors?)\b/i.test(message)) {
      if (msg.includes('emerald')) bp.brandTheme = 'emerald-gold';
      else if (msg.includes('forest')) bp.brandTheme = 'forest-bronze';
      else if (msg.includes('royal')) bp.brandTheme = 'royal-silver';
      else if (msg.includes('obsidian')) bp.brandTheme = 'obsidian-luxury';
      else if (msg.includes('navy')) bp.brandTheme = 'navy-gold';
    }
  }

  // Headline
  const quoteMatch = message.match(/["']([^"']{5,})["']/);
  if (quoteMatch && (msg.includes('headline') || msg.includes('title') || msg.includes('hero'))) {
    bp.heroHeadline = quoteMatch[1].trim();
  }

  // Amenities
  if (msg.includes('pool') && !bp.amenities.some(a => a.toLowerCase().includes('pool'))) {
    bp.amenities.push('Olympic-Length Swimming Pool');
  }
  if (msg.includes('squash') && !bp.amenities.some(a => a.toLowerCase().includes('squash'))) {
    bp.amenities.push('Indoor Squash Court');
  }
  if (msg.includes('padel') && !bp.amenities.some(a => a.toLowerCase().includes('padel'))) {
    bp.amenities.push('Professional Padel Court');
  }
  if (msg.includes('tennis') && !bp.amenities.some(a => a.toLowerCase().includes('tennis'))) {
    bp.amenities.push('Championship Tennis Court');
  }
  if (msg.includes('gym') && !bp.amenities.some(a => a.toLowerCase().includes('gym'))) {
    bp.amenities.push('High-Tech Gymnasium & Aerobics');
  }

  // Commute
  if (msg.includes('airport') && msg.includes('min')) {
    const minMatch = message.match(/(\d+)\s*mins?\s*(?:to)?\s*airport/i);
    if (minMatch) {
      const idx = bp.commute.findIndex(c => c.name.toLowerCase().includes('airport'));
      if (idx !== -1) bp.commute[idx].time = `${minMatch[1]} mins`;
      else bp.commute.push({ name: "Kempegowda Int'l Airport", time: `${minMatch[1]} mins` });
    }
  }

  // Font style detection
  const detectedFont = extractFontStyleFromText(message);
  if (detectedFont) {
    bp.fontStyle = detectedFont;
  }

  // Color theme detection (STRICT USER SPECIFICATION)
  const detectedTheme = extractColorThemeFromText(message);
  if (detectedTheme) {
    bp.brandTheme = detectedTheme;
  } else if (!isValidTheme(bp.brandTheme)) {
    bp.brandTheme = pickDistinctTheme(message, bp.projectName, bp.location);
  }

  bp.updatedAt = new Date().toISOString();
  return bp;
}

async function synthesizeBlueprintWithOpenCode(currentBp, userMessage, history = []) {
  // Build a clean, high-capacity semantic context summary without ASCII box art
  const cleanHistoryTurns = (history || []).slice(-15).map(h => {
    const role = h.role === 'user' ? 'USER' : 'ASSISTANT';
    let text = String(h.summary || h.content || '').trim();
    // Strip large ASCII wireframes so the AI gets pure semantic dialogue
    if (text.includes('┌') || text.includes('│') || text.includes('---')) {
      const parts = text.split(/```|\[SECTION|\u2500|\u2502|\u250C|\u2510/);
      text = parts[0].replace(/###\s*📐[^\n]+/g, '').replace(/\*Synthesized[^\n]+/g, '').replace(/>\s*💡[^\n]+/g, '').trim();
      if (!text) text = `Provided Content Blueprint for ${currentBp.projectName}.`;
    }
    if (text.length > 350) text = text.slice(0, 350) + '...';
    return `${role}: ${text}`;
  }).filter(Boolean);

  const contextSummary = cleanHistoryTurns.join('\n');

  const isIncrementalEdit = Boolean(
    currentBp && 
    currentBp.projectName && 
    currentBp.projectName !== 'Prestige Parklane' &&
    currentBp.totalLand
  );

  const editDirective = isIncrementalEdit ? `
CRITICAL INSTRUCTION - SURGICAL INCREMENTAL UPDATE:
You are editing an EXISTING established project: "${currentBp.projectName}" by "${currentBp.developerName}".
1. PRESERVE ALL established project data:
   - projectName: "${currentBp.projectName}"
   - developerName: "${currentBp.developerName}"
   - location: "${currentBp.location}"
   - totalLand: "${currentBp.totalLand}"
   - greenery: "${currentBp.greenery}"
   - towers: "${currentBp.towers}"
   - elevation: "${currentBp.elevation}"
   - clubhouseSize: "${currentBp.clubhouseSize}"
   - configurationsText: "${currentBp.configurationsText}"
    - reraId: "${currentBp.reraId}"
    - phone: "${currentBp.phone}"
    - whatsapp: "${currentBp.whatsapp}"
    - brandTheme: "${currentBp.brandTheme || 'navy-gold'}"
    - fontStyle: "${currentBp.fontStyle || 'playfair-montserrat'}"
2. Surgically apply ONLY the changes or refinements requested in the user's latest message: "${userMessage}".
3. Retain all other blueprint fields exactly as established.
` : `
INSTRUCTION - COMPREHENSIVE BLUEPRINT SYNTHESIS:
Extract and elevate all property details from the user's notes into a master-planned luxury PropTech narrative.
`;

  const themeDirective = `
🎨 CURATED THEME REGISTRY SELECTION DIRECTIVE (MANDATORY):
Do NOT generate or output raw 6-character hex codes or a generative "theme" object.
Instead, analyze the property typology, architectural scale, and setting, and output a single string field called "selectedThemeKey".
"selectedThemeKey" MUST EXACTLY match one of the keys in our Theme Registry:
• "emerald-gold" — for Biophilic Enclaves, Eco-Residences, Nature Sanctuaries, Golf/Garden Estates, and Lush Greenery developments.
• "obsidian-silver" — for Modern Tech Corridors, High-Rise Towers, Glass/Steel Skyscrapers, and Urban CBD Executive Residences.
• "coastal-azure" — for Waterfront Living, Marine Promenades, Coastal High-Rises, Sea-Facing Decks, and Resort Townships.
`;

  const prompt = `You are the Master PropTech Landing Page Architect and Conversion Strategist for Justflip, operating strictly under /landing-page-agent guidelines.
Your goal is to deeply comprehend user property notes or edit requests and synthesize a comprehensive, luxury Content Blueprint with high-converting marketing prose.

CURRENT BLUEPRINT STATE:
${JSON.stringify(currentBp, null, 2)}

RECENT CONVERSATION CONTEXT (LAST 15 TURNS):
${contextSummary || 'None'}

USER'S LATEST MESSAGE / PROPERTY NOTES:
"${userMessage}"

${editDirective}
${themeDirective}

INSTRUCTIONS:
1. Deeply analyze the user's message.
   - If the user provides new or raw property notes (project name, developer, location, acreages, towers, typologies, pricing, amenities, USPs, etc.), extract and elevate them into a master-planned luxury PropTech narrative.
   - If the user provides specific revisions (e.g. "change price to 1.5 Cr", "make theme emerald", "add squash court and infinity pool", "use Plus Jakarta Sans font style", "switch font to Inter"), update those exact fields and adjust the copy accordingly while keeping all other established data intact.
   - 🔤 DYNAMIC TYPOGRAPHY & FONT STYLES (MANDATORY /landing-page-agent RULE): Different landing pages have different font styles as specified by the user. If the user mentions any font style or typography preference (e.g. "Plus Jakarta Sans", "Inter", "Poppins", "Cormorant Garamond", "Outfit", "Cinzel", "Space Grotesk", "Lora", "DM Sans", "Playfair", or any custom Google font), extract it into "fontStyle" (e.g. 'plus-jakarta-sans', 'inter', 'cormorant-garamond', 'poppins', 'outfit', 'cinzel-raleway', 'lora-roboto', 'space-grotesk', 'dm-sans', or the exact font name). If not specified, retain the established fontStyle or default to 'playfair-montserrat'. The chosen font will transform the ENTIRE landing page typography.
   - Craft a compelling, luxury 3-paragraph "editorialStory" (separated by \\n\\n) detailing the architectural vision, biophilic layout, community lifestyle, and high rental/appreciation potential.
   - Craft high-converting "heroEyebrow", "heroHeadline", and "heroSubtitle".
   - Generate realistic "typologies" array with name, saleable area, carpet area, and pricing based on the user's data.
   - Generate relevant "amenities" (at least 6-8 items).
   - 🎨 CURATED THEME TOKEN SPECIFICATION:
     Analyze the property typology and output a single string field called "selectedThemeKey" that MUST EXACTLY match one of the keys in our Theme Registry:
     * 'emerald-gold' (Biophilic / Luxury)
     * 'obsidian-silver' (Modern Tech / High-Rise)
     * 'coastal-azure' (Waterfront / Resort)
     Do NOT generate raw hex codes or generative color palettes.

2. Return ONLY a single, valid JSON object (no markdown code blocks, no explanatory text outside the JSON):
{
  "explanation": "2-3 sentences explaining the exact modification applied, positioning strategy, and next steps",
  "blueprint": {
    "projectName": "...",
    "developerName": "...",
    "location": "...",
    "selectedThemeKey": "emerald-gold | obsidian-silver | coastal-azure",
    "fontStyle": "playfair-montserrat | plus-jakarta-sans | inter | poppins | cormorant-garamond | outfit | cinzel-raleway | lora-roboto | space-grotesk | dm-sans | <custom font>",
    "heroEyebrow": "⭐ ...",
    "heroHeadline": "...",
    "heroSubtitle": "...",
    "price": "...",
    "startingPrice": "...",
    "price1bhk": "...",
    "price2bhk": "...",
    "price3bhk": "...",
    "totalLand": "...",
    "towers": "...",
    "elevation": "...",
    "totalUnits": "...",
    "greenery": "...",
    "clubhouseSize": "...",
    "configurationsText": "...",
    "projectStatus": "...",
    "editorialStory": "Paragraph 1\\n\\nParagraph 2\\n\\nParagraph 3",
    "typologies": [
      { "name": "...", "area": "...", "carpet": "...", "price": "..." }
    ],
    "amenities": [ "...", "...", "...", "...", "...", "..." ],
    "commute": [
      { "name": "...", "time": "..." }
    ],
    "faqs": [
      { "question": "...", "answer": "..." }
    ],
    "reraId": "...",
    "phone": "...",
    "whatsapp": "..."
  }
}`;

  console.log(`[OpenCode Synthesis] Invoking OpenCode AI for blueprint update (${currentBp.projectName})...`);
  const aiRes = await callOpenCodeAI(prompt, 8000);
  
  if (aiRes.success && aiRes.reply) {
    try {
      let raw = aiRes.reply.trim();
      if (raw.startsWith('```json')) raw = raw.replace(/^```json\s*/i, '');
      else if (raw.startsWith('```')) raw = raw.replace(/^```\s*/i, '');
      if (raw.endsWith('```')) raw = raw.replace(/\s*```$/i, '');
      raw = raw.trim();

      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        raw = raw.substring(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(raw);
      if (parsed.blueprint && typeof parsed.blueprint === 'object') {
        console.log(`[OpenCode Synthesis] Successfully parsed OpenCode architectural blueprint!`);
        const updatedBp = { ...currentBp };
        for (const [k, v] of Object.entries(parsed.blueprint)) {
          if (v !== undefined && v !== null && v !== '' && v !== '...' && !String(v).includes('[Unchanged]')) {
            if (Array.isArray(v)) {
              if (v.length > 0) updatedBp[k] = v;
            } else if (typeof v === 'string') {
              if (v.trim().length > 0 && v.trim() !== '...') updatedBp[k] = v.trim();
            } else if (typeof v === 'object') {
              updatedBp[k] = { ...(updatedBp[k] || {}), ...v };
            } else {
              updatedBp[k] = v;
            }
          }
        }
        if (!updatedBp.startingPrice && updatedBp.price) updatedBp.startingPrice = updatedBp.price;
        if (!updatedBp.price && updatedBp.startingPrice) updatedBp.price = updatedBp.startingPrice;
        if (!updatedBp.price1bhk && updatedBp.startingPrice) updatedBp.price1bhk = updatedBp.startingPrice;

        // Ensure project name and developer name are never inadvertently overridden during incremental edits
        if (isIncrementalEdit) {
          if (!/(?:\b(?:developer|builder|promoter|company)\b)/i.test(userMessage) && currentBp.developerName) {
            updatedBp.developerName = currentBp.developerName;
          }
          if (!/(?:\b(?:project\s+name|rename|title)\b)/i.test(userMessage) && currentBp.projectName) {
            updatedBp.projectName = currentBp.projectName;
          }
        }

        // CURATED THEME REGISTRY TOKEN RESOLUTION
        let themeKey = parsed.blueprint.selectedThemeKey;
        if (!themeKey || !themeRegistry[themeKey]) {
          const lowerMsg = (userMessage + ' ' + (updatedBp.location || '') + ' ' + (updatedBp.projectName || '')).toLowerCase();
          if (lowerMsg.includes('emerald') || lowerMsg.includes('green') || lowerMsg.includes('biophilic') || lowerMsg.includes('forest') || lowerMsg.includes('garden')) {
            themeKey = 'emerald-gold';
          } else if (lowerMsg.includes('coastal') || lowerMsg.includes('azure') || lowerMsg.includes('water') || lowerMsg.includes('sea') || lowerMsg.includes('marina') || lowerMsg.includes('ocean')) {
            themeKey = 'coastal-azure';
          } else if (lowerMsg.includes('obsidian') || lowerMsg.includes('silver') || lowerMsg.includes('tech') || lowerMsg.includes('high-rise') || lowerMsg.includes('skyscraper')) {
            themeKey = 'obsidian-silver';
          } else if (currentBp.selectedThemeKey && themeRegistry[currentBp.selectedThemeKey]) {
            themeKey = currentBp.selectedThemeKey;
          } else {
            themeKey = DEFAULT_THEME_KEY;
          }
        }

        updatedBp.selectedThemeKey = themeKey;
        updatedBp.brandTheme = themeKey;
        const curPalette = getThemePalette(themeKey);
        updatedBp.theme = {
          primaryColor: curPalette.primary,
          secondaryColor: curPalette.secondary,
          accentColor: curPalette.accent,
          backgroundColor: curPalette.bg,
          textColor: curPalette.text,
          surfaceColor: curPalette.surface
        };

        const userExplicitFont = extractFontStyleFromText(userMessage);
        if (userExplicitFont) {
          updatedBp.fontStyle = userExplicitFont;
        } else if (!isValidFontStyle(updatedBp.fontStyle)) {
          updatedBp.fontStyle = 'playfair-montserrat';
        }

        if (!updatedBp.developerName || updatedBp.developerName.toLowerCase() === 'name') {
          if (currentBp.developerName && currentBp.developerName.toLowerCase() !== 'name') {
            updatedBp.developerName = currentBp.developerName;
          } else {
            const firstWord = (updatedBp.projectName || '').split(' ')[0];
            if (firstWord && firstWord.toLowerCase() !== 'the') {
              updatedBp.developerName = `${firstWord} Group`;
            }
          }
        }

        // Preserve custom uploaded images from currentBp
        if (currentBp.heroImage && (!updatedBp.heroImage || updatedBp.heroImage.includes('prestige-constructions'))) {
          updatedBp.heroImage = currentBp.heroImage;
        }
        if (Array.isArray(currentBp.galleryImages) && currentBp.galleryImages.length > 0) {
          if (!Array.isArray(updatedBp.galleryImages) || updatedBp.galleryImages.length === 0) {
            updatedBp.galleryImages = currentBp.galleryImages;
          }
        }
        if (Array.isArray(currentBp.floorPlanImages) && currentBp.floorPlanImages.length > 0) {
          if (!Array.isArray(updatedBp.floorPlanImages) || updatedBp.floorPlanImages.length === 0) {
            updatedBp.floorPlanImages = currentBp.floorPlanImages;
          }
        }

        updatedBp.updatedAt = new Date().toISOString();
        return {
          success: true,
          explanation: parsed.explanation || `Updated blueprint for **${updatedBp.projectName}** with your requested changes.`,
          blueprint: updatedBp
        };
      }
    } catch (parseErr) {
      console.warn(`[OpenCode Synthesis] JSON parsing failed: ${parseErr.message}. Output preview:`, aiRes.reply.slice(0, 250));
    }
  } else {
    console.warn(`[OpenCode Synthesis] OpenCode call did not succeed: ${aiRes.error || 'Empty reply'}`);
  }

  // Fallback to structured blueprint updater
  console.log(`[OpenCode Synthesis] Falling back to structured blueprint updater`);
  const finalBp = updateBlueprintFromMessage(currentBp, userMessage);
  return {
    success: false,
    explanation: `I've synthesized the **Content Blueprint** for **${finalBp.projectName}** by **${finalBp.developerName}** based on your notes. Review the text blueprint wireframe and click **Approve & Build Landing Page** (or type **"done"**) to generate the full page!`,
    blueprint: finalBp
  };
}

function formatTextLandingPageBlueprint(bp) {
  const pName = bp.projectName || 'Prestige Parklane';
  const dName = bp.developerName || 'Prestige Group';
  const loc = bp.location || 'KIADB Aerospace Park · Devanahalli, Bengaluru';
  const price = bp.price || bp.startingPrice || '₹1.85 Cr*';
  const eyebrow = bp.heroEyebrow || '⭐ EXCLUSIVE PRE-LAUNCH IN NORTH BENGALURU';
  const headline = bp.heroHeadline || `${pName} — Exclusive Luxury High-Rise Living`;
  const subtitle = bp.heroSubtitle || 'Master-planned luxury residential enclave with open green panoramas, signature clubhouse, and aerospace tech corridor connectivity.';
  const land = bp.totalLand || '11.76 Acres';
  const towers = bp.towers || '9 Towers';
  const elevation = bp.elevation || '3B + G + 24 Floors';
  const units = bp.totalUnits || '1,788 Apartments';
  const greenery = bp.greenery || '75% Open & Green Space';
  const clubhouse = bp.clubhouseSize || '~34,500 sq ft';
  const configs = bp.configurationsText || '1, 2 & 3 BHK Luxury Suites';
  const status = bp.projectStatus || 'New Launch (Phase 1)';
  const rera = bp.reraId || 'PRM/KA/RERA/1251/309/PR/150926/008941';
  const phone = bp.phone || '+91 93423 33197';
  const whatsapp = bp.whatsapp || '+91 74116 62228';

  const story = bp.editorialStory || 'Experience refined architectural luxury engineered for biophilic tranquility and strategic connectivity.\n\nMaster-planned high-rise towers rise above lush landscaped parks with dedicated wellness, recreation, and family recreation zones.\n\nPositioned in high-growth investment corridor with seamless transit to international airport, major business SEZs, and educational institutions.';
  const storyParas = story.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  const pad = (str, len) => {
    const s = String(str || '').slice(0, len);
    return s + ' '.repeat(Math.max(0, len - s.length));
  };

  const typologies = Array.isArray(bp.typologies) && bp.typologies.length > 0 ? bp.typologies : [
    { name: '1 BHK Luxury', area: '567 - 571 sq ft', carpet: '323 sq ft', price: `${price} Onwards` },
    { name: '2 BHK Premium', area: '828 - 880 sq ft', carpet: '512 sq ft', price: 'On Request*' },
    { name: '2 BHK Large', area: '1,087 - 1,103 sq ft', carpet: '685 sq ft', price: 'On Request*' },
    { name: '3 BHK Royal', area: '1,445 - 1,469 sq ft', carpet: '915 sq ft', price: 'On Request*' },
    { name: '3 BHK Luxury', area: '1,597 - 1,662 sq ft', carpet: '1,045 sq ft', price: 'On Request*' }
  ];

  const typologyRows = typologies.map(t => 
    `  │ ${pad(t.name, 21)} │ ${pad(t.area || t.saleable || 'On Request', 21)} │ ${pad(t.carpet || 'On Request', 21)} │ ${pad(t.price || price, 21)} │`
  ).join('\n');

  const commute = Array.isArray(bp.commute) && bp.commute.length > 0 ? bp.commute : [
    { name: "Kempegowda Int'l Airport", time: '15 mins / 20 km' },
    { name: 'Aerospace SEZ Hub', time: '2 mins' },
    { name: 'Manyata Tech Park', time: '20 mins / 18 km' }
  ];

  const commuteLines = commute.map(c => `    - ${c.name} : ${c.time}`).join('\n');

  const faqs = Array.isArray(bp.faqs) && bp.faqs.length > 0 ? bp.faqs : [
    { question: `What is the starting price at ${pName}?`, answer: `Residences at ${pName} start from ${price} onwards for entry configurations, with flexible milestone payment plans.` },
    { question: `Where exactly is ${pName} located?`, answer: `Prime strategic location at ${loc}, offering rapid arterial transit and proximity to key economic corridors.` },
    { question: `What configurations are available?`, answer: `Offering ${configs} across ${towers} with ${greenery}.` },
    { question: `Is ${pName} RERA registered?`, answer: `Statutory registration is under ${rera} with approvals from planning authorities.` }
  ];

  const faqLines = faqs.map((f, i) => `  ${i + 1}. Q: ${f.question || f.q}\n     A: ${f.answer || f.a}`).join('\n');

  const floorPlanLines = typologies.map((t, i) => 
    `  • Tab ${i + 1}: [${t.name}] — Saleable: ${t.area || 'On Request'} | Carpet: ${t.carpet || 'On Request'}`
  ).join('\n');

  const heroImageName = bp.heroImage ? (bp.heroImage.startsWith('/uploads/') ? '📸 ' + path.basename(bp.heroImage) : bp.heroImage) : 'Curated Architectural Elevation (Default)';
  const customGalleryList = Array.isArray(bp.galleryImages) && bp.galleryImages.length > 0
    ? bp.galleryImages.slice(0, 6).map((img, i) => `  • Slot ${i + 1}: ${img.startsWith('/uploads/') ? '📸 Custom Asset: ' + path.basename(img) : img}`).join('\n')
    : `  • Slot 1: Hero Dusk Perspective / Tower Elevation\n  • Slot 2: Grand Double-Height Entrance Lobby\n  • Slot 3: Resort Swimming Pool & Cabana Deck\n  • Slot 4: Expansive Living & Dining Suite Model Flat\n  • Slot 5: Master Bedroom with Large Viewing Balcony\n  • Slot 6: Landscaped Central Boulevard & Gardens`;

  return '```text\n' +
`════════════════════════════════════════════════════════════════════════════════
🏛️  LANDING PAGE CONTENT BLUEPRINT — ${pName.toUpperCase()}
════════════════════════════════════════════════════════════════════════════════

[SECTION 1: FLOATING NAVIGATION BAR]
  • Logo / Title: ${pName} by ${dName}
  • Navigation Links: Overview | Specs | Pricing | Location | Floor Plans | Amenities | FAQs
  • Call-to-Action Buttons: [📞 Call: ${phone}]  [💬 WhatsApp: ${whatsapp}]  [📅 Schedule Site Visit]

[SECTION 2: HERO BANNER & INSTANT ENQUIRY]
  • Eyebrow Badge: ${eyebrow}
  • Main Headline: ${headline}
  • Supporting Subtitle: ${subtitle}
  • Metric Badges Strip: [${land}] · [${towers}] · [${configs}] · [${greenery}]
  • Price Callout Card:
    ┌────────────────────────────────────────────────────────────────────────┐
    │ Starting Price: ${pad(price + ' Onwards', 54)}│
    │ Guidance: Exclusive Launch Allocation · Construction Linked Payment    │
    └────────────────────────────────────────────────────────────────────────┘
  • Quick Registration Hook (Lead Form):
    [Name] [Phone (+91/Intl Dial Code)] [Configuration Preference] -> [⚡ Get Instant Cost Sheet & Brochure]

[SECTION 3: 8-CARD SCALE & QUICK FACTS GRID]
  ┌───────────────────────┬───────────────────────┬───────────────────────┬───────────────────────┐
  │ 1. TOTAL LAND AREA    │ 2. TOWERS & ELEVATION │ 3. TOTAL RESIDENCES   │ 4. TYPOLOGIES SPECTRUM│
  │    ${pad(land, 19)}│    ${pad(towers + ' / ' + elevation.split(' ')[0], 19)}│    ${pad(units, 19)}│    ${pad(configs.substring(0, 19), 19)}│
  ├───────────────────────┼───────────────────────┼───────────────────────┼───────────────────────┤
  │ 5. GRAND CLUBHOUSE    │ 6. OPEN GREENS RATIO  │ 7. CURRENT STATUS     │ 8. DEVELOPER TRUST    │
  │    ${pad(clubhouse, 19)}│    ${pad(greenery, 19)}│    ${pad(status, 19)}│    ${pad(dName.substring(0, 19), 19)}│
  └───────────────────────┴───────────────────────┴───────────────────────┴───────────────────────┘

[SECTION 4: EDITORIAL STORY & MASTER SPECS SUMMARY]
  • Editorial Narrative:
${storyParas.map((p, i) => `    Paragraph ${i + 1}: "${p}"`).join('\n\n')}
  • "Find Your Home Here" Master Specs Table:
    1. Project Name: ${pName}
    2. Developer & Promoter: ${dName}
    3. Location: ${loc}
    4. Configurations: ${configs}
    5. Land Extent: ${land}
    6. Starting Price: ${price}
    7. Statutory Status: ${status}
    8. RERA Registration No: ${rera}

[SECTION 5: PROJECT OVERVIEW & 6 ARCHITECTURAL HIGHLIGHTS]
  • Highlight 1: Master-Planned Architectural Enclave — Engineered for natural light, ventilation, and acoustic privacy
  • Highlight 2: Sprawling Biophilic Central Park — ${greenery} dedicated to landscaped gardens, trees, and reflexology trails
  • Highlight 3: Signature Resort Clubhouse — ${clubhouse} of curated lifestyle, leisure, and social amenities
  • Highlight 4: Multi-Tier Active Sports Clusters — Tennis, squash, padel, basketball, and jogging circuits
  • Highlight 5: Strategic Growth Corridor — Direct access to arterial expressways, international airport, and IT hubs
  • Highlight 6: Institutional Developer Trust — Built to premium civil engineering standards with strict RERA accountability

[SECTION 6: E-BROCHURE WHATSAPP DOWNLOAD HOOK]
  • Headline: "Download the Official 30-Page Master Brochure"
  • Subhead: "Floor plans, master layout, technical specifications, and detailed payment schedule delivered instantly."
  • Micro-Commitment CTA: [📲 Receive Brochure on WhatsApp]

[SECTION 7: DYNAMIC PRICING MATRIX]
  ┌───────────────────────┬───────────────────────┬───────────────────────┬───────────────────────┐
  │ TYPOLOGY CONFIGURATION│ SALEABLE AREA         │ CARPET AREA (RERA)    │ PRICE STARTING POINT  │
  ├───────────────────────┼───────────────────────┼───────────────────────┼───────────────────────┤
${typologyRows}
  └───────────────────────┴───────────────────────┴───────────────────────┴───────────────────────┘
  • Payment Plan Note: 10% Booking · 80% Construction Linked (CLP) · 10% on Possession

[SECTION 8: LOCATION & COMMUTE HUB (3-CATEGORY BREAKDOWN)]
  • Category 1: Airport & Arterial Corridors
${commuteLines}
  • Category 2: Employment SEZs & Business Parks
    - Aerospace Park & Tech SEZ Hubs : Adjacent (2-5 mins)
    - Major IT & Business Corridors : 15-25 mins
  • Category 3: Healthcare, Education & Daily Conveniences
    - Top International Schools & Universities : 10-15 mins
    - Multi-Specialty Hospitals & Retail Malls : 15 mins
  • 3 Strategic Growth Drivers:
    1. Infrastructure Catalyst: Metro connectivity and arterial highway widening
    2. Commercial Job Magnet: High-density aerospace & tech corridor with rapid employment expansion
    3. High Rental Demand Zone: Strong rental yields driven by airport and corporate workforce

[SECTION 9: FULL-WIDTH STATEMENT VISUAL BREAK]
  • Luxury Pull-Quote Banner:
    "Where expansive green nature converges with contemporary architectural grandeur."

[SECTION 10: ON-RECORD STATUTORY SANCTIONS STRIP]
  • RERA Registration Approval: ${rera}
  • Planning Authority Sanction: Sanctioned & Approved by Competent Authorities
  • Designated Escrow Account: Statutory Escrow Banking on Record (100% Buyer Fund Security)
  • General Civil Contractor on Record: Tier-1 Institutional Construction Partner

[SECTION 11: TABBED FLOOR PLANS BREAKDOWN]
${floorPlanLines}
  • Floor Plan Action: [📥 Download Complete Plan PDF with Dimension Breakdown]

[SECTION 12: AMENITIES & RECREATIONAL CLUSTERS (3 HUBS)]
  • Cluster A: The Central Landscape & Wellness
    - Swimming Pool & Sun Deck · Jogging & Walking Track · Reflexology Path · Senior Citizens' Pavilion
  • Cluster B: Active Sports & Adventure Play
    - Tennis / Pickleball Court · Half Basketball Court · Cricket Pitch Net · Kids' Play Area
  • Cluster C: Grand Clubhouse & Lifestyle Privileges
    - Fitness Gym · Badminton Courts · Banquet Hall · Co-Working Lounge · Steam & Sauna

[SECTION 13: VISUAL GALLERY & PHOTO MATRIX]
  • Hero Landmark Image: ${heroImageName}
${customGalleryList}

[SECTION 14: TECHNICAL CONSTRUCTION SPECIFICATIONS]
  • Structure: RCC Framed Shear Wall structure, Seismic Zone II compliant
  • Flooring: Vitrified tiles in Living/Dining/Bedrooms; Anti-skid in Bathrooms & Balconies
  • Doors & Windows: Teakwood frame main door; UPVC 3-track sliding windows
  • Kitchen & Utility: Granite counter, stainless steel sink, provision for chimney
  • Plumbing & Sanitary: Jaguar / Kohler / equivalent premium fixtures
  • Electrical & Power: Concealed copper wiring, 100% DG backup for common areas

[SECTION 15: DEVELOPER HERITAGE & TRACK RECORD]
  • Developer Brand: ${dName}
  • Track Record: Landmark legacy with millions of square feet delivered across key metropolitan markets
  • Prominent Milestones: Award-winning architectural standards, trusted delivery timeline, high consumer trust

[SECTION 16: GUIDED SITE VISIT SCHEDULER]
  • Headline: "Experience ${pName} in Person"
  • Offer: Free chauffeur-driven site visit pick-up & drop from your location.
  • CTA: [📅 Book Private Guided Site Visit]

[SECTION 17: FREQUENTLY ASKED QUESTIONS (FAQ HUB)]
${faqLines}

[SECTION 18: STATUTORY FOOTER & LEGAL DISCLAIMER]
  • Channel Partner Disclosure: Authorised Real Estate Advisory Partner
  • Statutory State RERA Number: ${rera}
  • Dedicated Privacy Policy: /generated/${bp.slug || 'prestige-parklane'}/privacy-policy.html
  • RERA Legal Disclaimer: Project details for informational purposes only. Images are artist's impressions.
════════════════════════════════════════════════════════════════════════════════` +
'\n```';
}

function formatCodexLiveUpdateChangelog(bp, userMessage, synthExplanation) {
  const pName = bp.projectName || 'Prestige Parklane';
  const price = bp.price || bp.startingPrice || '₹1.85 Cr*';
  const theme = bp.brandTheme || 'navy-gold';
  const themeTokens = generatorTemplate.getThemeTokens(theme);
  const fontStyle = bp.fontStyle || 'playfair-montserrat';
  const fontTokens = generatorTemplate.getFontTokens(fontStyle);

  return `⚡ **Live In-Place Edit Applied** \`[Codex / Live-Sync Engine]\`

I've surgically updated the live production code for **${pName}** in response to:
> *"${userMessage}"*

### 🛠️ Surgical Modifications Applied:
- 🔄 **Pricing & Typologies:** Synchronized starting price point to **${price}** across Hero Banner (Section 2) & Dynamic Pricing Matrix (Section 7).
- 🔤 **Typography & Font Style:** Applied **\`${fontTokens.name}\`** across all 20 sections of the landing page.
- 🎨 **Brand Palette & Color Theme:** Applied **\`${themeTokens.name || theme}\`** across Tailwind CSS tokens, badges, gradients, and buttons.
- 📐 **Architectural Blueprint:** Master data state updated with verified configurations, amenities, and narrative copy.
- 🚀 **Live Compilation:** Production \`index.html\` recompiled with zero-cache live reload.

${synthExplanation ? `> ℹ️ **Architectural Note:** ${synthExplanation}\n\n` : ''}*The live preview canvas on the right has automatically hot-reloaded with your changes. You can test interactive tabs, enquiry modals, or request further fine-tuning directly in chat.*`;
}

function renderBlueprintHtml(bp) {
  const pName = escapeHtml(bp.projectName || 'Luxury Residences');
  const dName = escapeHtml(bp.developerName || 'Premier Developer');
  const loc = escapeHtml(bp.location || 'Prime Location');
  const price = escapeHtml(bp.price || bp.startingPrice || '₹1.85 Cr*');
  const headline = escapeHtml(bp.heroHeadline || `${pName} — Exclusive Luxury Living`);
  const subtitle = escapeHtml(bp.heroSubtitle || 'Master-planned luxury residences with expansive open greens and signature lifestyle amenities.');
  const fontTokens = generatorTemplate.getFontTokens(bp.fontStyle || 'playfair-montserrat');
  const themeTokens = generatorTemplate.getThemeTokens(bp.theme || bp.brandTheme || 'navy-gold');

  // Narrative story paragraphs
  const rawStory = bp.editorialStory || 'Experience refined architectural luxury engineered for biophilic tranquility and strategic connectivity.';
  const storyParas = rawStory.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  // Visual Assets Setup
  const defaultElevation = 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg';
  const heroDisplayImg = bp.heroImage || defaultElevation;
  const isHeroCustom = !!(bp.heroImage && !bp.heroImage.includes('prestige-constructions'));

  const defaultStockGallery = [
    { title: 'Grand Double-Height Entrance Lobby', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-garden.jpg' },
    { title: 'Hero Dusk Architectural Elevation', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg' },
    { title: 'Resort Swimming Pool & Cabana Deck', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/pool-fountain.jpg' },
    { title: 'Expansive Living & Dining Suite', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-dusk.jpg' },
    { title: 'Master Bedroom with Balcony Panoramas', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/garden-walk.jpg' },
    { title: 'Landscaped Central Boulevard & Flora', url: 'https://prestige-constructions.co.in/prestige-parklane-bangalore/img/pool-evening.jpg' }
  ];

  const customGallery = Array.isArray(bp.galleryImages) ? bp.galleryImages : [];
  const gallerySlots = [0, 1, 2, 3, 4, 5].map(idx => {
    if (customGallery[idx]) {
      return {
        url: customGallery[idx],
        title: `Project Asset ${idx + 1}`,
        isCustom: !customGallery[idx].includes('prestige-constructions')
      };
    }
    return {
      url: defaultStockGallery[idx].url,
      title: defaultStockGallery[idx].title,
      isCustom: false
    };
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Content Blueprint — ${pName}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${fontTokens.googleUrl}" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    :root {
      --bp-bg: ${themeTokens.indigoNight || '#08111e'};
      --bp-card: ${themeTokens.indigoDeep || '#0f172a'};
      --bp-subcard: ${themeTokens.indigo || '#1e293b'};
      --bp-accent: ${themeTokens.gold || '#e2c76e'};
      --bp-accent-bright: ${themeTokens.goldBright || '#fef08a'};
      --bp-accent-soft: ${themeTokens.goldSoft || '#f1dc96'};
      --bp-border: ${themeTokens.lineGold || 'rgba(212,175,55,.3)'};
      --bp-border-sub: ${themeTokens.line || 'rgba(255,255,255,0.08)'};
      --bp-text: ${themeTokens.isDark ? '#f8fafc' : '#ffffff'};
      --bp-muted: ${themeTokens.mutedLight || '#94a3b8'};
    }
    body { font-family: ${fontTokens.textFont}; background: var(--bp-bg); color: var(--bp-text); }
    .serif { font-family: ${fontTokens.displayFont}; }
    .bp-card { background: var(--bp-card); border: 1px solid var(--bp-border-sub); }
    .bp-subcard { background: var(--bp-subcard); border: 1px solid var(--bp-border-sub); }
    .bp-accent { color: var(--bp-accent); }
    .bp-accent-bright { color: var(--bp-accent-bright); }
    .bp-gold-border { border-color: var(--bp-border); }
  </style>
</head>
<body class="p-4 lg:p-6 space-y-5">
  <!-- Top Approval Banner -->
  <div class="sticky top-0 z-50 p-4 rounded-2xl bp-card border bp-gold-border shadow-xl backdrop-blur-md flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-2.5">
      <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
      <div>
        <div class="flex items-center gap-2">
          <h2 class="text-white font-bold text-sm tracking-wide">📐 Content Blueprint Active</h2>
          <span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-[10px] font-bold border border-emerald-500/30">STAGE 1: REVIEW &amp; REFINE</span>
        </div>
        <p class="text-[11px] text-slate-400">Review copy, pricing &amp; specs below. Type edits in the chat, or click build when ready!</p>
      </div>
    </div>
    <button type="button" onclick="window.parent.postMessage({action:'approve_and_build'}, '*')" class="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-xs shadow-lg transition flex items-center gap-1.5 cursor-pointer active:scale-95">
      <span class="material-symbols-outlined text-[16px]">rocket_launch</span>
      <span>Approve &amp; Build Landing Page</span>
    </button>
  </div>

  <!-- Hero & Positioning Card -->
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-4">
    <div class="flex items-center justify-between border-b pb-3" style="border-color: var(--bp-border-sub)">
      <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[16px]">flag</span>
        <span>Section 2: Hero Positioning &amp; Pricing Callout</span>
      </span>
      <span class="text-[11px] bp-accent-bright font-mono">🎨 ${escapeHtml(themeTokens.name || bp.brandTheme || 'navy-gold')}</span>
    </div>
    <div>
      <div class="text-[10px] px-2.5 py-1 rounded-full bp-subcard bp-accent-bright font-mono inline-block mb-2 font-bold">${escapeHtml(bp.heroEyebrow || '⭐ EXCLUSIVE PRE-LAUNCH')}</div>
      <h1 class="text-xl lg:text-2xl text-white font-bold serif leading-tight">${headline}</h1>
      <p class="text-xs text-slate-300 mt-2 leading-relaxed max-w-2xl">${subtitle}</p>
    </div>
    <div class="p-3.5 rounded-xl bp-subcard border bp-gold-border flex items-center justify-between gap-3">
      <div>
        <div class="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Starting Price Hook</div>
        <div class="text-xl font-bold bp-accent serif">${price}</div>
      </div>
      <div class="text-right">
        <div class="text-[10px] text-slate-400">Status</div>
        <div class="text-xs font-semibold text-emerald-400">${escapeHtml(bp.projectStatus || 'New Launch')}</div>
      </div>
    </div>
  </div>

  <!-- Section 13: Project Visual Media & Ingested Assets Preview -->
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-4">
    <div class="flex items-center justify-between border-b pb-3" style="border-color: var(--bp-border-sub)">
      <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[16px]">photo_library</span>
        <span>📸 Section 13: Project Visual Media &amp; Ingested Assets</span>
      </span>
      <span class="text-[10px] px-2 py-0.5 rounded-full ${isHeroCustom || customGallery.length ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'} font-mono font-bold">
        ${isHeroCustom || customGallery.length ? '✨ Custom Assets Active' : 'Default Architectural Media'}
      </span>
    </div>

    <!-- Hero Image Banner Slot -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between text-[11px]">
        <span class="font-bold text-white flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px] text-amber-400">star</span>
          Hero Elevation Visual (Section 2 Backdrop)
        </span>
        <span class="text-[10px] font-mono ${isHeroCustom ? 'text-emerald-400 font-bold' : 'text-slate-400'}">
          ${isHeroCustom ? '✅ Custom Uploaded Image' : 'Standard Architectural Elevation'}
        </span>
      </div>
      <div class="relative h-44 sm:h-56 rounded-xl overflow-hidden border bp-gold-border group bg-black/40">
        <img src="${escapeHtml(heroDisplayImg)}" alt="${pName} Elevation" class="w-full h-full object-cover transition duration-300 group-hover:scale-105" onerror="this.src='https://prestige-constructions.co.in/prestige-parklane-bangalore/img/hero-elevation.jpg'" />
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 pointer-events-none"></div>
        <div class="absolute bottom-3 left-3 right-3 flex items-center justify-between text-xs text-white">
          <span class="font-bold truncate">${pName} — Landmark Elevation</span>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-black/60 border border-white/20">Hero Asset</span>
        </div>
      </div>
    </div>

    <!-- Gallery Matrix (Slots 1 to 6) -->
    <div class="space-y-1.5 pt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="font-bold text-white flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px] text-emerald-400">grid_view</span>
          Section 13: 6-Slot Visual Gallery Matrix
        </span>
        <span class="text-[10px] text-slate-400 font-mono">${customGallery.length} custom / 6 total</span>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        ${gallerySlots.map((slot, idx) => `
          <div class="relative rounded-xl overflow-hidden border bp-subcard group bg-black/40 flex flex-col">
            <div class="h-28 overflow-hidden relative">
              <img src="${escapeHtml(slot.url)}" alt="${escapeHtml(slot.title)}" class="w-full h-full object-cover transition duration-300 group-hover:scale-105" onerror="this.src='https://prestige-constructions.co.in/prestige-parklane-bangalore/img/towers-garden.jpg'" />
              <span class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold ${slot.isCustom ? 'bg-emerald-600 text-white shadow' : 'bg-black/70 text-slate-300'} font-mono">
                ${slot.isCustom ? 'Custom Upload' : 'Slot ' + (idx + 1)}
              </span>
            </div>
            <div class="p-2 text-[10px] text-slate-300 font-medium truncate">${escapeHtml(slot.title)}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${Array.isArray(bp.floorPlanImages) && bp.floorPlanImages.length > 0 ? `
    <!-- Floor Plans Ingested -->
    <div class="space-y-1.5 pt-2">
      <div class="flex items-center justify-between text-[11px]">
        <span class="font-bold text-white flex items-center gap-1">
          <span class="material-symbols-outlined text-[14px] text-blue-400">floor_lamp</span>
          Floor Plan &amp; Layout Assets
        </span>
        <span class="text-[10px] text-emerald-400 font-mono font-bold">${bp.floorPlanImages.length} Floor Plans Ingested</span>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        ${bp.floorPlanImages.map((fpUrl, fpIdx) => `
          <div class="relative rounded-xl overflow-hidden border bp-subcard group bg-black/40 flex flex-col">
            <div class="h-28 overflow-hidden relative bg-white/5 flex items-center justify-center">
              <img src="${escapeHtml(fpUrl)}" alt="Floor Plan ${fpIdx + 1}" class="w-full h-full object-contain p-1" />
              <span class="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-blue-600 text-white font-mono">Plan ${fpIdx + 1}</span>
            </div>
            <div class="p-2 text-[10px] text-slate-300 font-medium truncate">Typology Layout ${fpIdx + 1}</div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}
  </div>

  <!-- 8-Card Quick Facts Grid -->
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
    <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
      <span class="material-symbols-outlined text-[16px]">grid_view</span>
      <span>Section 3: 8-Card Scale &amp; Quick Facts Grid</span>
    </span>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Total Land</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.totalLand || '11.76 Acres')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Towers &amp; Elev.</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.towers || '9 Towers')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Total Units</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.totalUnits || '1,788 Units')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Typologies</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.configurationsText || '1, 2 & 3 BHK')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Grand Clubhouse</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.clubhouseSize || '~34,500 sq ft')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Open Greens</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.greenery || '75% Open Space')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Contact / Sales</div><div class="text-sm font-bold text-white serif">${escapeHtml(bp.phone || '+91 93423 33197')}</div></div>
      <div class="p-3 rounded-xl bp-subcard"><div class="text-[10px] text-slate-400">Developer Trust</div><div class="text-sm font-bold text-white serif">${dName}</div></div>
    </div>
  </div>

  <!-- Section 4: Architectural Editorial Narrative & Vision -->
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
    <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
      <span class="material-symbols-outlined text-[16px]">auto_stories</span>
      <span>Section 4: Architectural Narrative &amp; Editorial Vision</span>
    </span>
    <div class="space-y-3 text-xs leading-relaxed text-slate-300">
      ${storyParas.map((para, idx) => `
        <div class="p-3.5 rounded-xl bp-subcard">
          <div class="text-[10px] font-bold bp-accent-bright uppercase tracking-wider mb-1">Paragraph ${idx + 1}</div>
          <p>${escapeHtml(para)}</p>
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Dynamic Pricing Matrix -->
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
    <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
      <span class="material-symbols-outlined text-[16px]">payments</span>
      <span>Section 7: 6-Typology Dynamic Pricing Matrix</span>
    </span>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs">
        <thead class="bp-subcard text-slate-400 font-mono text-[10px] uppercase">
          <tr><th class="p-2.5">Configuration</th><th class="p-2.5">Saleable Area</th><th class="p-2.5">Carpet Area</th><th class="p-2.5">Pricing Point</th></tr>
        </thead>
        <tbody class="divide-y font-medium" style="border-color: var(--bp-border-sub)">
          ${(bp.typologies || []).map(t => `
            <tr class="hover:bg-white/5">
              <td class="p-2.5 text-white font-bold">${escapeHtml(t.name)}</td>
              <td class="p-2.5 text-slate-300 font-mono">${escapeHtml(t.area)}</td>
              <td class="p-2.5 text-slate-400 font-mono">${escapeHtml(t.carpet || 'On Request')}</td>
              <td class="p-2.5 bp-accent font-bold">${escapeHtml(t.price)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Amenities & Commute -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
      <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[16px]">pool</span>
        <span>Section 12: Amenities Inventory</span>
      </span>
      <ul class="space-y-1.5 text-xs text-slate-300">
        ${(bp.amenities || []).map(a => `<li class="flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full" style="background:var(--bp-accent)"></span><span>${escapeHtml(a)}</span></li>`).join('')}
      </ul>
    </div>
    <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
      <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
        <span class="material-symbols-outlined text-[16px]">near_me</span>
        <span>Section 8: Commute &amp; Location Hub</span>
      </span>
      <div class="text-xs font-semibold text-white mb-2">📍 ${loc}</div>
      <ul class="space-y-1.5 text-xs text-slate-300">
        ${(bp.commute || []).map(c => `<li class="flex items-center justify-between border-b pb-1" style="border-color: var(--bp-border-sub)"><span>${escapeHtml(c.name || c.label)}</span><span class="font-mono bp-accent font-bold">${escapeHtml(c.time)}</span></li>`).join('')}
      </ul>
    </div>
  </div>

  <!-- Section 15: Strategic Project FAQs -->
  ${Array.isArray(bp.faqs) && bp.faqs.length > 0 ? `
  <div class="p-5 rounded-2xl bp-card shadow-md space-y-3">
    <span class="text-xs font-bold bp-accent uppercase tracking-widest flex items-center gap-1.5">
      <span class="material-symbols-outlined text-[16px]">help</span>
      <span>Section 15: Project FAQs</span>
    </span>
    <div class="space-y-2">
      ${bp.faqs.map(f => `
        <div class="p-3 rounded-xl bp-subcard text-xs">
          <div class="font-semibold text-white mb-1">❓ ${escapeHtml(f.question || f.q)}</div>
          <div class="text-slate-400 leading-relaxed">${escapeHtml(f.answer || f.a)}</div>
        </div>
      `).join('')}
    </div>
  </div>
  ` : ''}

  <!-- RERA Compliance -->
  <div class="p-4 rounded-xl bp-subcard text-[11px] text-slate-400 flex items-center justify-between">
    <div><strong>Statutory RERA ID:</strong> ${escapeHtml(bp.reraId || 'Verification Required')}</div>
    <div><strong>Promoter:</strong> ${dName}</div>
  </div>

  <!-- Bottom CTA Bar -->
  <div class="p-6 rounded-2xl bp-card border bp-gold-border text-center space-y-3">
    <h3 class="text-white font-bold text-sm">Ready to build the full 20-section landing page?</h3>
    <p class="text-xs text-slate-400 max-w-md mx-auto">Once approved, the system synthesizes full Tailwind CSS, interactive tabbed floor plans, WhatsApp lead hooks, and zero-cache live preview.</p>
    <button type="button" onclick="window.parent.postMessage({action:'approve_and_build'}, '*')" class="px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-xs shadow-lg transition inline-flex items-center gap-2 cursor-pointer active:scale-95">
      <span class="material-symbols-outlined text-[18px]">rocket_launch</span>
      <span>Approve &amp; Build Landing Page Now</span>
    </button>
  </div>
</body>
</html>`;
}

function isApprovalIntent(message) {
  const msg = message.toLowerCase().trim();
  const directWords = ['done', 'build', 'approve', 'approved', 'ok', 'okay', 'proceed', 'make landing page', 'build landing page', 'generate', 'looks good', 'create'];
  if (directWords.includes(msg)) return true;
  if (/^(done|ok|okay|approve|approved|build|proceed)\b/i.test(msg)) return true;
  if (msg.includes('approve and build') || msg.includes('make the landing page') || msg.includes('generate the landing page') || msg.includes('build now')) return true;
  return false;
}

  // API Endpoint: GET /api/chat/blueprint (Get visual & JSON blueprint for a project)
  if (req.method === 'GET' && pathname === '/api/chat/blueprint') {
    const slug = (parsedUrl.searchParams.get('slug') || 'prestige-parklane').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const bp = getOrInitBlueprint(slug, 'Prestige Parklane');
    const blueprintHtml = renderBlueprintHtml(bp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      slug,
      selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
      blueprint: bp,
      blueprintHtml
    }));
    return;
  }

  // API Endpoint: POST /api/chat/build (Synthesize full 20-section landing page from approved blueprint)
  if (req.method === 'POST' && pathname === '/api/chat/build') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const slug = (payload.slug || 'prestige-parklane').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const outputDir = path.join(GENERATED_DIR, slug);
        fs.mkdirSync(outputDir, { recursive: true });
        const sourceData = payload.intakeData || payload;
        const bp = getOrInitBlueprint(slug, payload.projectName, sourceData);
        if (sourceData) {
          const isCustom = (url) => url && typeof url === 'string' && !url.includes('prestige-constructions') && !url.includes('prestige-parklane');
          if (sourceData.heroImage && (isCustom(sourceData.heroImage) || !bp.heroImage)) {
            bp.heroImage = sourceData.heroImage;
          }
          ['brochureImage1', 'brochureImage2', 'brochureImage3', 'locationMapImage', 'greenBannerImage', 'tourBackgroundImage', 'gal1', 'gal2', 'gal3', 'gal4', 'gal5', 'gal6'].forEach(k => {
            if (sourceData[k] && (isCustom(sourceData[k]) || !bp[k])) bp[k] = sourceData[k];
          });
          if (Array.isArray(sourceData.overviewImages) && sourceData.overviewImages.length > 0) {
            bp.overviewImages = sourceData.overviewImages;
          }
          if (Array.isArray(sourceData.lifeAtImages) && sourceData.lifeAtImages.length > 0) {
            bp.lifeAtImages = sourceData.lifeAtImages;
          }
          if (Array.isArray(sourceData.galleryImages) && sourceData.galleryImages.length > 0) {
            if (!Array.isArray(bp.galleryImages)) bp.galleryImages = [];
            sourceData.galleryImages.forEach(u => {
              if (u && !bp.galleryImages.includes(u)) bp.galleryImages.push(u);
            });
          }
          if (Array.isArray(sourceData.floorPlanImages) && sourceData.floorPlanImages.length > 0) {
            bp.floorPlanImages = sourceData.floorPlanImages;
          }
        }

        const generatedPath = path.join(outputDir, 'index.html');
        if (bp.generationMode === 'opencode-html' && fs.existsSync(generatedPath)) {
          const fullHtml = fs.readFileSync(generatedPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            html: fullHtml,
            projectName: bp.projectName,
            reply: `The OpenCode generated page for **${bp.projectName}** is already live.`
          }));
          return;
        }

        // Build full 20-section production HTML
        let fullHtml = generatorTemplate.buildFullLandingPage(bp);
        fullHtml = inlineUploadImages(fullHtml, PUBLIC_DIR);
        fs.writeFileSync(generatedPath, fullHtml, 'utf8');

        // Build and save dedicated Privacy Policy page
        if (typeof generatorTemplate.buildPrivacyPolicyPage === 'function') {
          const privHtml = generatorTemplate.buildPrivacyPolicyPage(bp);
          fs.writeFileSync(path.join(outputDir, 'privacy-policy.html'), privHtml, 'utf8');
        }

        // Mark blueprint as built
        bp.status = 'built';
        bp.updatedAt = new Date().toISOString();
        const bpPath = path.join(outputDir, 'chat-blueprint.json');
        fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');

        // Register site
        registerOrUpdateSite({
          site_id: slug,
          project_name: bp.projectName,
          developer_name: bp.developerName,
          live_url: `/generated/${slug}/index.html`,
          preview_url: `/generated/${slug}/index.html`,
          status: 'live'
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'built',
          slug,
          selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
          previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
          privacyUrl: `/generated/${slug}/privacy-policy.html`,
          html: fullHtml,
          projectName: bp.projectName,
          reply: `🎉 Landing page and Privacy Policy successfully generated from your approved blueprint! You can now explore the live 20-section interactive page in the preview canvas.`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/chat/save-images (Save hot-swapped CMS image props from live control box)
  if (req.method === 'POST' && pathname === '/api/chat/save-images') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const slug = (payload.slug || 'prestige-parklane').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const outputDir = path.join(GENERATED_DIR, slug);
        fs.mkdirSync(outputDir, { recursive: true });
        const bp = getOrInitBlueprint(slug, payload.projectName || 'Prestige Parklane');
        
        if (payload.images && typeof payload.images === 'object') {
          Object.assign(bp, payload.images);
        }
        bp.updatedAt = new Date().toISOString();
        const bpPath = path.join(outputDir, 'chat-blueprint.json');
        fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');

        if (payload.recompile !== false) {
          const generatedPath = path.join(outputDir, 'index.html');
          if (bp.generationMode === 'opencode-html' && fs.existsSync(generatedPath)) {
            const stagingPath = path.join(outputDir, 'index.opencode-staging.html');
            const fullHtml = await generateLandingPageWithOpenCode({
              projectName: bp.projectName,
              projectFacts: sanitizeDashboardFacts({ ...payload.images, projectName: bp.projectName }),
              designBrief: bp.designBrief || '',
              request: 'Update the existing page image sources to match the supplied Image CMS slot URLs. Preserve its layout, text, palette, and behavior.',
              sourcePath: generatedPath,
              stagingPath
            });
            fs.copyFileSync(stagingPath, generatedPath);
            fs.unlinkSync(stagingPath);
          } else {
            let fullHtml = generatorTemplate.buildFullLandingPage(bp);
            fullHtml = inlineUploadImages(fullHtml, PUBLIC_DIR);
            fs.writeFileSync(generatedPath, fullHtml, 'utf8');
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'CMS images successfully updated and saved to blueprint.',
          slug
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: GET /api/chat/history (Get context window memory for a project)
  if (req.method === 'GET' && pathname === '/api/chat/history') {
    const slug = (parsedUrl.searchParams.get('slug') || 'prestige-parklane').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const histPath = path.join(GENERATED_DIR, slug, 'chat-history.json');
    let history = [];
    if (fs.existsSync(histPath)) {
      try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch (e) { history = []; }
    }
    const htmlPath = path.join(GENERATED_DIR, slug, 'index.html');
    const hasPage = fs.existsSync(htmlPath);
    const fileSize = hasPage ? fs.statSync(htmlPath).size : 0;
    const bp = getOrInitBlueprint(slug, 'Prestige Parklane');
    const blueprintHtml = renderBlueprintHtml(bp);

    // Ensure privacy-policy.html exists in project directory
    const privPath = path.join(GENERATED_DIR, slug, 'privacy-policy.html');
    if (!fs.existsSync(privPath) && typeof generatorTemplate.buildPrivacyPolicyPage === 'function') {
      try {
        fs.writeFileSync(privPath, generatorTemplate.buildPrivacyPolicyPage(bp), 'utf8');
      } catch (e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      slug,
      selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
      hasPage,
      fileSize,
      previewUrl: hasPage ? `/generated/${slug}/index.html` : null,
      privacyUrl: `/generated/${slug}/privacy-policy.html`,
      history,
      blueprint: bp,
      blueprintHtml
    }));
    return;
  }

  // API Endpoint: POST /api/chat/message (Conversational AI Landing Page Builder with Real OpenCode & Memory)
  if (req.method === 'POST' && pathname === '/api/chat/message') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userMessage = String(payload.message || '').trim();
        const generationEngine = String(payload.generationEngine || 'opencode').toLowerCase() === 'gemini' ? 'gemini' : 'opencode';
        let projectName = String(payload.intakeData?.projectName || payload.projectName || payload.slug || 'Prestige Parklane');
        let slug = String(payload.slug || projectName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'prestige-parklane';
        const isDesignBrief = isFullPageDesignPrompt(userMessage);
        if (generationEngine === 'gemini' && !isDesignBrief) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Gemini generation is for new full-page design briefs. Switch to OpenCode for chat edits and quick changes.' }));
          return;
        }
        const briefProjectFacts = isDesignBrief ? extractSelfContainedBriefProjectFacts(userMessage) : null;
        if (briefProjectFacts) {
          projectName = briefProjectFacts.projectName;
          slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'new-project';
        }

        // Check if user is submitting a NEW property brief rather than an edit to the current project
        const isExplicitNewProperty = /(?:\b(?:create|start|build|make|generate)\b.*?\b(?:landing\s+page|project|residence|township|property|listing)\b)/i.test(userMessage) ||
          /(?:1\.\s*Project\s+Specs|Project\s+Name\s*:|DLF\s+ONE\s+MIDTOWN|LANDING\s+PAGE\s+BLUEPRINT|\/landing-page-agent)/i.test(userMessage);

        const isBrochureDump = (
          userMessage.length > 200 &&
          /(?:\b(?:rera|acres?|clubhouses?|amenities|possession|configurations?|typologies|super\s+luxury|sq\.?\s*ft)\b)/i.test(userMessage) &&
          !userMessage.toLowerCase().includes(projectName.toLowerCase())
        );

        const isNewPropertySubmission = isExplicitNewProperty || isBrochureDump;

        let bp;
        let isAlreadyBuilt = false;

        if (isDesignBrief) {
          console.log(`[Chat API] Detected full-page design brief for "${projectName}". Using the connected OpenCode TUI.`);
          if (briefProjectFacts) {
            bp = {
              ...briefProjectFacts,
              slug,
              status: 'draft',
              updatedAt: new Date().toISOString()
            };
          } else {
            bp = getOrInitBlueprint(slug, projectName, payload.intakeData);
            const locationConflict = findDashboardLocationConflict(userMessage, {
              ...payload.intakeData,
              ...bp
            });
            if (locationConflict) {
              const requestedLocation = resolveDesignBriefLocation(userMessage, '');
              const assistantReply = `I couldn't safely generate this page: the prompt asks for ${requestedLocation}, but the dashboard still contains ${locationConflict}. Update the project's location-specific facts, map, RERA, contact, and images to match ${requestedLocation}, then submit again. The live page was left unchanged.`;
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: assistantReply, code: 'PROJECT_LOCATION_CONFLICT' }));
              return;
            }
            bp.projectName = projectName;
            bp.developerName = payload.intakeData?.developerName || bp.developerName;
            bp.location = resolveDesignBriefLocation(userMessage, payload.intakeData?.location || bp.location);
          }
          isAlreadyBuilt = false;
        } else if (isNewPropertySubmission) {
          console.log(`[Chat API] Detected NEW property submission in chat message! Synthesizing fresh project...`);
          const freshBp = extractFreshBlueprintFromText(userMessage, slug);
          slug = freshBp.slug;
          projectName = freshBp.projectName;
          bp = freshBp;
          isAlreadyBuilt = false; // Always gate new properties through Stage 1 Blueprint!
        } else {
          bp = getOrInitBlueprint(slug, projectName, payload.intakeData);
          isAlreadyBuilt = (bp.status === 'built' && fs.existsSync(path.join(GENERATED_DIR, slug, 'index.html')));
        }

        const outputDir = path.join(GENERATED_DIR, slug);
        fs.mkdirSync(outputDir, { recursive: true });
        const generatedPath = path.join(outputDir, 'index.html');
        const histPath = path.join(outputDir, 'chat-history.json');
        const bpPath = path.join(outputDir, 'chat-blueprint.json');

        // Load existing history (Memory Context Window)
        let history = [];
        if (!isNewPropertySubmission && fs.existsSync(histPath)) {
          try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch (e) { history = []; }
        }
        if (!isNewPropertySubmission && Array.isArray(payload.chatHistory) && payload.chatHistory.length > history.length) {
          history = payload.chatHistory;
        }

        // Ingest uploaded image attachments from chat or intake data
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const uploadedImages = rawAttachments.filter(a => {
          if (!a || !a.url) return false;
          const isImgType = a.type && a.type.startsWith('image/');
          const hasImgExt = /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(a.url);
          const isUploadPath = String(a.url).startsWith('/uploads/');
          return isImgType || hasImgExt || isUploadPath;
        });

        if (uploadedImages.length > 0) {
          console.log(`[Chat API] Ingesting ${uploadedImages.length} uploaded image(s) into blueprint for "${slug}"`);
          if (!Array.isArray(bp.galleryImages)) bp.galleryImages = [];

          const urls = uploadedImages.map(u => u.url);
          bp.heroImage = urls[0];
          bp.overviewImages = urls.slice(0, 4);
          bp.gal1 = urls[0];
          if (urls[1]) { bp.brochureImage1 = urls[1]; bp.gal2 = urls[1]; }
          if (urls[2]) { bp.brochureImage2 = urls[2]; bp.gal3 = urls[2]; }
          if (urls[3]) { bp.brochureImage3 = urls[3]; bp.greenBannerImage = urls[3]; bp.gal4 = urls[3]; }
          if (urls[4]) { bp.tourBackgroundImage = urls[4]; bp.gal5 = urls[4]; }
          if (urls[5]) { bp.gal6 = urls[5]; }

          uploadedImages.forEach((imgObj, idx) => {
            const imgUrl = imgObj.url;
            const isHeroIntent = /(?:hero|elevation|main\s+banner|cover|front|header)/i.test(imgObj.name || '') ||
                                 /(?:hero|elevation|main\s+image|cover)/i.test(userMessage);
            if (isHeroIntent) {
              bp.heroImage = imgUrl;
            }
            if (!bp.galleryImages.includes(imgUrl)) {
              bp.galleryImages.unshift(imgUrl);
            }

            const isFloorPlan = /(?:floor|plan|layout|unit|bhk|carpet)/i.test(imgObj.name || '') ||
                                /(?:floor\s*plan|layout)/i.test(userMessage);
            if (isFloorPlan) {
              if (!Array.isArray(bp.floorPlanImages)) bp.floorPlanImages = [];
              if (!bp.floorPlanImages.includes(imgUrl)) {
                bp.floorPlanImages.push(imgUrl);
              }
            }
          });

          if (bp.galleryImages.length > 12) {
            bp.galleryImages = bp.galleryImages.slice(0, 12);
          }
        }

        // Ingest custom / uploaded images from Studio sidebar and form inputs
        // A named self-contained brief owns its project identity and assets.
        // Do not fill missing brief media from the currently selected dashboard project.
        if (payload.intakeData && !briefProjectFacts) {
          const intake = payload.intakeData;
          const isCustom = (url) => url && typeof url === 'string' && !url.includes('prestige-constructions') && !url.includes('prestige-parklane');
          
          if (intake.heroImage && (isCustom(intake.heroImage) || !bp.heroImage)) {
            bp.heroImage = intake.heroImage;
          }
          if (Array.isArray(intake.overviewImages) && intake.overviewImages.some(isCustom)) {
            bp.overviewImages = intake.overviewImages;
          } else if (intake.overviewImage && isCustom(intake.overviewImage)) {
            if (!Array.isArray(bp.overviewImages)) bp.overviewImages = [];
            bp.overviewImages[0] = intake.overviewImage;
          }
          if (isCustom(intake.brochureImage1)) bp.brochureImage1 = intake.brochureImage1;
          if (isCustom(intake.brochureImage2)) bp.brochureImage2 = intake.brochureImage2;
          if (isCustom(intake.brochureImage3)) bp.brochureImage3 = intake.brochureImage3;
          if (isCustom(intake.locationMapImage)) bp.locationMapImage = intake.locationMapImage;
          if (isCustom(intake.greenBannerImage)) bp.greenBannerImage = intake.greenBannerImage;
          if (isCustom(intake.tourBackgroundImage)) bp.tourBackgroundImage = intake.tourBackgroundImage;
          ['gal1', 'gal2', 'gal3', 'gal4', 'gal5', 'gal6'].forEach(k => {
            if (isCustom(intake[k])) bp[k] = intake[k];
          });
          if (Array.isArray(intake.galleryImages) && intake.galleryImages.length > 0) {
            if (!Array.isArray(bp.galleryImages)) bp.galleryImages = [];
            intake.galleryImages.filter(isCustom).forEach(u => {
              if (!bp.galleryImages.includes(u)) bp.galleryImages.push(u);
            });
          }
          if (Array.isArray(intake.floorPlanImages) && intake.floorPlanImages.length > 0) {
            bp.floorPlanImages = intake.floorPlanImages;
          }
        }

        if (isDesignBrief) {
          const projectFacts = sanitizeDashboardFacts(briefProjectFacts
            ? {
                ...briefProjectFacts,
                uploadedImages: uploadedImages.map(({ name, type, url }) => ({ name, type, url }))
              }
            : {
                ...payload.intakeData,
                projectName: payload.intakeData?.projectName || projectName,
                developerName: payload.intakeData?.developerName || bp.developerName,
                location: bp.location || payload.intakeData?.location,
                uploadedImages: uploadedImages.map(({ name, type, url }) => ({ name, type, url }))
              });
          const stagingName = generationEngine === 'gemini' ? 'index.gemini-staging.html' : 'index.opencode-staging.html';
          const stagingPath = path.join(outputDir, stagingName);
          const generationOptions = {
            projectName,
            projectFacts,
            projectFactsSource: briefProjectFacts ? 'brief' : 'dashboard',
            designBrief: userMessage,
            request: 'Create the complete page from the design brief. Treat examples and placeholder labels as guidance, not project facts.',
            stagingPath
          };
          const cfg = generationEngine === 'gemini' ? getConfig() : null;
          const html = generationEngine === 'gemini'
            ? await generateLandingPageWithGemini({
                ...generationOptions,
                apiKey: String(payload.intakeData?.apiKey || cfg.apiKey || process.env.GEMINI_API_KEY || '').trim(),
                preferredModel: payload.intakeData?.geminiModel || cfg.geminiModel
              })
            : await generateLandingPageWithOpenCode(generationOptions);

          fs.copyFileSync(stagingPath, generatedPath);
          fs.unlinkSync(stagingPath);
          bp.status = 'built';
          bp.generationMode = `${generationEngine}-html`;
          bp.projectFactsSource = briefProjectFacts ? 'brief' : 'dashboard';
          bp.designBrief = userMessage;
          bp.updatedAt = new Date().toISOString();
          fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');

          registerOrUpdateSite({
            site_id: slug,
            project_name: projectName,
            developer_name: bp.developerName,
            live_url: `/generated/${slug}/index.html`,
            preview_url: `/generated/${slug}/index.html`,
            status: 'live'
          });

          const factsSourceLabel = briefProjectFacts?.projectStatus
            ? 'the fictional concept details in your brief'
            : briefProjectFacts ? 'the complete project facts in your brief' : 'the dashboard facts';
          const engineLabel = generationEngine === 'gemini' ? 'Gemini API' : 'OpenCode';
          const assistantReply = `The landing page for **${projectName}** is ready. I used ${factsSourceLabel}, your design brief, and the LandingPageAgent skill with ${engineLabel}.`;
          history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
          history.push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            projectName,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            reply: assistantReply,
            fileSize: html.length,
            history,
            html,
            blueprint: bp
          }));
          return;
        }

        // ============================================
        // CHECK IF USER IS APPROVING TO BUILD THE PAGE
        // ============================================
        const userWantsBuild = payload.action === 'build' || isApprovalIntent(userMessage);

        if (userWantsBuild && isAlreadyBuilt && ['opencode-html', 'gemini-html'].includes(bp.generationMode)) {
          const generationLabel = bp.generationMode === 'gemini-html' ? 'Gemini generated' : 'OpenCode generated';
          const assistantReply = `**${bp.projectName}** is already built and live. Your ${generationLabel} page is still active.`;
          history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
          history.push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');
          const html = fs.readFileSync(generatedPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            projectName: bp.projectName,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            reply: assistantReply,
            fileSize: html.length,
            history,
            html,
            blueprint: bp
          }));
          return;
        }

        if (userWantsBuild) {
          console.log(`[Chat API] User approved blueprint for "${slug}". Building 20-section landing page...`);
          let fullHtml = generatorTemplate.buildFullLandingPage(bp);
          fullHtml = inlineUploadImages(fullHtml, PUBLIC_DIR);
          fs.writeFileSync(generatedPath, fullHtml, 'utf8');

          // Generate and save dedicated Privacy Policy page
          if (typeof generatorTemplate.buildPrivacyPolicyPage === 'function') {
            const privHtml = generatorTemplate.buildPrivacyPolicyPage(bp);
            fs.writeFileSync(path.join(outputDir, 'privacy-policy.html'), privHtml, 'utf8');
          }

          bp.status = 'built';
          bp.updatedAt = new Date().toISOString();
          fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');

          registerOrUpdateSite({
            site_id: slug,
            project_name: bp.projectName,
            developer_name: bp.developerName,
            live_url: `/generated/${slug}/index.html`,
            preview_url: `/generated/${slug}/index.html`,
            status: 'live'
          });

          const assistantReply = `🎉 **Landing page generated and live!** I've built the complete 20-section high-converting page and dedicated **Privacy Policy** for **${bp.projectName}** according to your approved blueprint and /landing-page-agent rules. The live interactive preview is now active.`;

          history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
          history.push({ role: 'assistant', content: assistantReply, timestamp: Date.now() });
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            projectName: bp.projectName,
            selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            privacyUrl: `/generated/${slug}/privacy-policy.html`,
            reply: assistantReply,
            fileSize: fullHtml.length,
            history,
            html: fullHtml,
            blueprint: bp,
            blueprintHtml: renderBlueprintHtml(bp)
          }));
          return;
        }

        const userWantsExplicitBlueprint = /^(?:view|show|display|see|reset)\s+(?:content\s+)?blueprint\b/i.test(userMessage);

        if (isAlreadyBuilt && ['opencode-html', 'gemini-html'].includes(bp.generationMode) && !userWantsExplicitBlueprint) {
          const savedBriefFacts = bp.projectFactsSource === 'brief'
            ? extractSelfContainedBriefProjectFacts(bp.designBrief)
            : null;
          const projectFacts = sanitizeDashboardFacts(savedBriefFacts || {
            ...payload.intakeData,
            projectName: payload.intakeData?.projectName || bp.projectName,
            developerName: payload.intakeData?.developerName || bp.developerName,
            location: bp.location || payload.intakeData?.location
          });
          const stagingPath = path.join(outputDir, 'index.opencode-staging.html');
          const html = await generateLandingPageWithOpenCode({
            projectName: bp.projectName,
            projectFacts,
            projectFactsSource: savedBriefFacts ? 'brief' : 'dashboard',
            designBrief: bp.designBrief || userMessage,
            request: userMessage,
            sourcePath: generatedPath,
            stagingPath
          });

          fs.copyFileSync(stagingPath, generatedPath);
          fs.unlinkSync(stagingPath);
          bp.updatedAt = new Date().toISOString();
          fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');
          registerOrUpdateSite({
            site_id: slug,
            project_name: bp.projectName,
            developer_name: bp.developerName,
            live_url: `/generated/${slug}/index.html`,
            preview_url: `/generated/${slug}/index.html`,
            status: 'live'
          });

          const assistantReply = `Updated **${bp.projectName}** in the connected OpenCode session while preserving its original design brief and palette.`;
          history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
          history.push({ role: 'assistant', content: assistantReply, summary: assistantReply, timestamp: Date.now() });
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            projectName: bp.projectName,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            reply: assistantReply,
            fileSize: html.length,
            history,
            html,
            blueprint: bp
          }));
          return;
        }

        // ========================================================
        // STAGE 2: LIVE PAGE IN-PLACE EDITING (CLAUDE / CODEX STYLE)
        // ========================================================
        if (isAlreadyBuilt && !userWantsExplicitBlueprint) {
          console.log(`[Chat API] Live page active. Applying surgical live edit via OpenCode AI for: "${userMessage.substring(0, 80)}..."`);
          const synthResult = await synthesizeBlueprintWithOpenCode(bp, userMessage, history);
          bp = synthResult.blueprint;
          bp.status = 'built';
          bp.updatedAt = new Date().toISOString();

          // Immediately recompile full 20-section live production HTML
          let fullHtml = generatorTemplate.buildFullLandingPage(bp);
          fullHtml = inlineUploadImages(fullHtml, PUBLIC_DIR);
          fs.writeFileSync(generatedPath, fullHtml, 'utf8');

          // Ensure dedicated Privacy Policy page is also updated
          if (typeof generatorTemplate.buildPrivacyPolicyPage === 'function') {
            const privHtml = generatorTemplate.buildPrivacyPolicyPage(bp);
            fs.writeFileSync(path.join(outputDir, 'privacy-policy.html'), privHtml, 'utf8');
          }

          fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');

          registerOrUpdateSite({
            site_id: slug,
            project_name: bp.projectName,
            developer_name: bp.developerName,
            live_url: `/generated/${slug}/index.html`,
            preview_url: `/generated/${slug}/index.html`,
            status: 'live'
          });

          const assistantReply = formatCodexLiveUpdateChangelog(bp, userMessage, synthResult.explanation);

          const shortSummary = synthResult.explanation || `Updated ${bp.projectName} in response to: "${userMessage.slice(0, 100)}"`;

          history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
          history.push({ role: 'assistant', content: assistantReply, summary: shortSummary, timestamp: Date.now() });
          fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            mode: 'built',
            slug,
            projectName: bp.projectName,
            selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
            previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
            privacyUrl: `/generated/${slug}/privacy-policy.html`,
            reply: assistantReply,
            fileSize: fullHtml.length,
            history,
            html: fullHtml,
            blueprint: bp,
            blueprintHtml: renderBlueprintHtml(bp)
          }));
          return;
        }

        // ========================================================
        // STAGE 1: BLUEPRINT STAGE (FULL TEXT WIREFRAME PRESENTATION)
        // ========================================================
        console.log(`[Chat API] Stage 1 Content Blueprint synthesis via OpenCode AI for: "${userMessage.substring(0, 80)}..."`);
        const synthResult = await synthesizeBlueprintWithOpenCode(bp, userMessage, history);
        bp = synthResult.blueprint;
        bp.status = 'blueprint';
        bp.updatedAt = new Date().toISOString();

        fs.writeFileSync(bpPath, JSON.stringify(bp, null, 2), 'utf8');
        const blueprintHtml = renderBlueprintHtml(bp);

        // ALWAYS immediately recompile and synchronize landing page HTML code with latest color tokens
        let fullHtml = '';
        try {
          fullHtml = generatorTemplate.buildFullLandingPage(bp);
          fullHtml = inlineUploadImages(fullHtml, PUBLIC_DIR);
          fs.writeFileSync(generatedPath, fullHtml, 'utf8');
          console.log(`[HTML Compiler] Landing page HTML code successfully recompiled with color "${bp.brandTheme}" -> ${generatedPath}`);

          registerOrUpdateSite({
            site_id: slug,
            project_name: bp.projectName,
            developer_name: bp.developerName,
            live_url: `/generated/${slug}/index.html`,
            preview_url: `/generated/${slug}/index.html`,
            status: 'live'
          });
        } catch (syncErr) {
          console.warn('[HTML Compiler] Sync note:', syncErr.message);
        }

        const textWireframe = formatTextLandingPageBlueprint(bp);
        const assistantReply = `### 📐 Landing Page Content Blueprint: **${bp.projectName}**
*Synthesized via OpenCode AI engine under \`/landing-page-agent\` specifications.*

${synthResult.explanation ? `> 💡 **Architectural Strategy:** ${synthResult.explanation}\n\n` : ''}${textWireframe}

---
👉 **Next Steps:**
• **Refine Content:** Tell me what you'd like to adjust (e.g. *"change price to ₹1.5 Cr"*, *"set theme to emerald"*, *"add pickleball court"*).
• **Compile Live Page:** Reply **"Done"**, **"Approve"**, or click **[Approve & Build Landing Page]** in the preview tab to compile the live 20-section page with Tailwind CSS & interactive scripts.`;

        const shortSummary = synthResult.explanation || `Refined Content Blueprint for ${bp.projectName} in response to: "${userMessage.slice(0, 100)}"`;

        history.push({ role: 'user', content: userMessage, attachments: rawAttachments, timestamp: Date.now() });
        history.push({ role: 'assistant', content: assistantReply, summary: shortSummary, timestamp: Date.now() });
        fs.writeFileSync(histPath, JSON.stringify(history, null, 2), 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: 'blueprint',
          slug,
          projectName: bp.projectName,
          selectedThemeKey: bp.selectedThemeKey || DEFAULT_THEME_KEY,
          previewUrl: `/generated/${slug}/index.html?t=${Date.now()}`,
          reply: assistantReply,
          history,
          blueprint: bp,
          blueprintHtml
        }));
      } catch (err) {
        console.error('[Chat API Error]:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Endpoint: POST /api/antigravity/handoff (Create a local agent task package)
  if (req.method === 'POST' && pathname === '/api/antigravity/handoff') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const formData = JSON.parse(body || '{}');
        const projectName = String(formData.projectName || 'Luxury Residences');
        const slug = String(formData.siteId || projectName)
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'luxury-residences';
        const outputDir = path.join(GENERATED_DIR, slug);
        fs.mkdirSync(outputDir, { recursive: true });
        const safePayload = { ...formData };
        delete safePayload.apiKey;
        delete safePayload.openRouterApiKey;
        delete safePayload.geminiModel;
        delete safePayload.openRouterModel;
        const requestPath = path.join(outputDir, 'antigravity-request.json');
        const briefPath = path.join(outputDir, 'ANTIGRAVITY-TASK.md');
        fs.writeFileSync(requestPath, JSON.stringify(safePayload, null, 2), 'utf8');
        fs.writeFileSync(briefPath, `# Generate ${projectName} Landing Page

Read [SKILL.md](${SKILL_PATH}) before starting.

## Input brief

Read [antigravity-request.json](./antigravity-request.json).

## Required output

Create or replace [index.html](./index.html) in this folder only.
Follow the complete 20-section real-estate landing-page architecture from SKILL.md.
Use only facts in the JSON brief. Do not invent prices, RERA data, possession dates, sizes, approvals, or amenities.
Use "On Request" or "[Verification Required]" for missing details.
Make the page standalone, responsive, accessible, and interactive.
Validate that index.html is a complete HTML document before finishing.
`, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          projectId: slug,
          taskFile: `/generated/${slug}/ANTIGRAVITY-TASK.md`,
          requestFile: `/generated/${slug}/antigravity-request.json`,
          outputFile: `/generated/${slug}/index.html`,
          localFolder: outputDir,
          message: 'Antigravity task package created. Open ANTIGRAVITY-TASK.md in Antigravity and run the task.'
        }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/generate-landing-page') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const formData = JSON.parse(body || '{}');
        const cfg = getConfig();
        const apiKey = (formData.apiKey || cfg.apiKey || process.env.GEMINI_API_KEY || '').trim();
        const openRouterApiKey = (formData.openRouterApiKey || cfg.openRouterApiKey || process.env.OPENROUTER_API_KEY || '').trim();
        const makeWebhookUrl = (formData.makeWebhookUrl || cfg.makeWebhookUrl || '').trim();
        const engineMode = (formData.engineMode || (apiKey ? 'gemini' : (openRouterApiKey ? 'openrouter' : (makeWebhookUrl ? 'webhook' : 'autonomous')))).toLowerCase();

        const projectName = formData.projectName || 'Luxury Residences';
        const developerName = formData.developerName || 'Premier Developer';
        const location = formData.location || 'Bengaluru';
        const slug = formData.slug || formData.siteId || projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'luxury-residences';
        formData.slug = slug;

        let finalHtml = '';
        let synthesizedBy = 'Built-in 20-Section Autonomous Engine';
        let aiMetadata = null;

        // Branch 1: Make.com Webhook Scenario
        if (engineMode === 'webhook' && makeWebhookUrl) {
          console.log(`[Studio] Forwarding to Make.com Webhook: ${makeWebhookUrl}`);
          try {
            const makeResponse = await fetch(makeWebhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(formData)
            });
            const makeText = await makeResponse.text();
            let cleanHtml = cleanMarkdownHtml(makeText);
            if (cleanHtml && cleanHtml.includes('<html')) {
              finalHtml = cleanHtml;
              synthesizedBy = 'Make.com Webhook Scenario';
            } else {
              console.warn('[Studio] Webhook response did not return full HTML, using 20-section generator.');
              finalHtml = generatorTemplate.buildFullLandingPage(formData);
              synthesizedBy = 'Autonomous Engine (Webhook Fallback)';
            }
          } catch (mErr) {
            console.warn('[Studio] Make.com webhook failed, using 20-section autonomous generator:', mErr.message);
            finalHtml = generatorTemplate.buildFullLandingPage(formData);
            synthesizedBy = 'Autonomous Engine (Webhook Error Fallback)';
          }
        }
        // Branch 2: Google Gemini AI (Smart Copy & 20-Section Architecture Synthesis)
        else if (engineMode === 'gemini' && apiKey) {
          console.log(`[Studio] Calling Gemini AI for project "${projectName}" to synthesize bespoke luxury copy and FAQs...`);
          const geminiResult = await synthesizeContentWithGemini(formData, apiKey, cfg.geminiModel);

          if (geminiResult.success && geminiResult.content) {
            console.log(`[Studio] Gemini (${geminiResult.model}) synthesized custom copy successfully! Ingesting into 20-section master template...`);
            const ai = geminiResult.content;
            aiMetadata = ai;
            synthesizedBy = `Google Gemini AI (${geminiResult.model})`;

            // Merge AI-generated luxury marketing copy into project payload
            if (ai.heroEyebrow) formData.heroEyebrow = ai.heroEyebrow;
            if (ai.heroSubtitle) formData.heroSubtitle = ai.heroSubtitle;
            if (ai.editorialStory) formData.editorialStory = ai.editorialStory;
            if (ai.overviewBullets && Array.isArray(ai.overviewBullets)) formData.overviewBullets = ai.overviewBullets;
            if (ai.statementQuote) {
              formData.statementQuote = ai.statementQuote;
              formData.statementQuoteTitle = ai.statementQuote;
            }
            if (ai.faqs && Array.isArray(ai.faqs)) formData.faqs = ai.faqs;

            finalHtml = generatorTemplate.buildFullLandingPage(formData);
          } else {
            console.warn(`[Studio] Gemini synthesis did not complete (${geminiResult.error || 'Unknown error'}). Using autonomous 20-section generator.`);
            finalHtml = generatorTemplate.buildFullLandingPage(formData);
            synthesizedBy = 'Autonomous Engine (Gemini Fallback)';
          }
        }
        // Branch 3: OpenRouter (OpenAI-compatible multi-model gateway)
        else if (engineMode === 'openrouter' && openRouterApiKey) {
          console.log(`[Studio] Calling OpenRouter for project "${projectName}"...`);
          const openRouterResult = await synthesizeContentWithOpenRouter(
            formData,
            openRouterApiKey,
            formData.openRouterModel || cfg.openRouterModel
          );
          if (openRouterResult.success && openRouterResult.content) {
            const ai = openRouterResult.content;
            aiMetadata = ai;
            synthesizedBy = `OpenRouter (${openRouterResult.model})`;
            if (ai.heroEyebrow) formData.heroEyebrow = ai.heroEyebrow;
            if (ai.heroSubtitle) formData.heroSubtitle = ai.heroSubtitle;
            if (ai.editorialStory) formData.editorialStory = ai.editorialStory;
            if (Array.isArray(ai.overviewBullets)) formData.overviewBullets = ai.overviewBullets;
            if (ai.statementQuote) {
              formData.statementQuote = ai.statementQuote;
              formData.statementQuoteTitle = ai.statementQuote;
            }
            if (Array.isArray(ai.faqs)) formData.faqs = ai.faqs;
            finalHtml = generatorTemplate.buildFullLandingPage(formData);
          } else {
            console.warn(`[Studio] OpenRouter synthesis did not complete (${openRouterResult.error || 'Unknown error'}). Using autonomous generator.`);
            finalHtml = generatorTemplate.buildFullLandingPage(formData);
            synthesizedBy = 'Autonomous Engine (OpenRouter Fallback)';
          }
        }
        // Branch 3: Built-in Autonomous 20-Section Engine (Instant, Offline)
        else {
          console.log(`[Studio] Synthesizing autonomously with built-in 20-section generator template...`);
          finalHtml = generatorTemplate.buildFullLandingPage(formData);
          synthesizedBy = 'Built-in 20-Section Autonomous Engine';
        }

        // Inline all uploaded image files as base64 so HTML is 100% self-contained & portable
        finalHtml = inlineUploadImages(finalHtml, PUBLIC_DIR);

        // Save generated landing page to public/generated/<slug>/index.html
        const projectDir = path.join(GENERATED_DIR, slug);
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, 'index.html'), finalHtml, 'utf8');

        console.log(`[Studio] Successfully saved landing page (${synthesizedBy}) to: public/generated/${slug}/index.html`);

        // Automatically register / update site in Sites Registry (Local & Cloud)
        registerOrUpdateSite({
          site_id: slug,
          project_name: projectName,
          developer_name: developerName,
          live_url: `/generated/${slug}/index.html`,
          preview_url: `/generated/${slug}/index.html`,
          status: 'live'
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          html: finalHtml,
          slug: slug,
          previewUrl: `/generated/${slug}/index.html`,
          projectName: projectName,
          synthesizedBy: synthesizedBy,
          engine: engineMode,
          aiContent: aiMetadata
        }));

      } catch (err) {
        console.error('[Studio] Server error during generation:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'SERVER_ERROR', message: err.message }));
      }
    });
    return;
  }

  // Static File Serving (Root serves Landing Page Studio)
  let targetFile = (pathname === '/' || pathname === '/studio')
    ? 'landing-page-studio.html'
    : (pathname === '/login' ? 'login.html' : ((pathname === '/seo' || pathname === '/seo-dashboard') ? 'index.html' : pathname));
  let filePath = path.join(PUBLIC_DIR, targetFile);
  if (!fs.existsSync(filePath) && fs.existsSync(path.join(ROOT_DIR, 'public', targetFile))) {
    filePath = path.join(ROOT_DIR, 'public', targetFile);
  } else if (!fs.existsSync(filePath) && fs.existsSync(path.join(FRONTEND_DIR, targetFile))) {
    filePath = path.join(FRONTEND_DIR, targetFile);
  }

  // If target path is a directory, resolve index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const indexPath = path.join(filePath, 'index.html');
    if (fs.existsSync(indexPath)) {
      filePath = indexPath;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error: ' + err.code);
      }
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log('\n======================================================');
  console.log('🚀 JUSTFLIP LANDING PAGE STUDIO ENGINE IS LIVE!');
  console.log('======================================================');
  console.log(`\n👉 Open Studio Dashboard     : http://127.0.0.1:${PORT}`);
  console.log(`👉 Network Access (Office IP) : http://${localIp}:${PORT}`);
  const agent = getCodingAgentConfig();
  console.log(`🧠 AI Engine Connected        : ${fs.existsSync(SKILL_PATH) ? 'SKILL.md Validated ✅' : 'Default Prompts'}`);
  console.log(`🤖 Coding Agent Provider      : ${agent.provider} (${agent.command})`);
  console.log(`📡 Generator API Endpoint     : http://${localIp}:${PORT}/api/generate-landing-page`);
  console.log('\nPress Ctrl+C to stop the studio server.\n');
});
