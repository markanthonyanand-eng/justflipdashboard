// Minimal curated palette registry used by the studio API.
// The landing page generator has its own detailed theme tokens; these values
// provide the palette fields used by backend blueprint initialization.
const palettes = {
  'navy-gold': { primary: '#0C2340', secondary: '#C5A059', accent: '#E8C978', bg: '#F8F6F0', text: '#172033', surface: '#FFFFFF' },
  'emerald-gold': { primary: '#123D32', secondary: '#B89555', accent: '#D7BC7A', bg: '#F6F5EF', text: '#17251F', surface: '#FFFFFF' },
  'forest-bronze': { primary: '#183B32', secondary: '#A87545', accent: '#C99A65', bg: '#F5F2EA', text: '#202820', surface: '#FFFFFF' },
  'royal-silver': { primary: '#172447', secondary: '#AEB8C8', accent: '#D5DCE5', bg: '#F4F6FA', text: '#172033', surface: '#FFFFFF' },
  'sapphire-gold': { primary: '#123A68', secondary: '#C5A059', accent: '#E3C77E', bg: '#F5F7FA', text: '#182538', surface: '#FFFFFF' },
  'terracotta-warm': { primary: '#8C4635', secondary: '#C3945B', accent: '#DAB17B', bg: '#FBF5EE', text: '#33231F', surface: '#FFFFFF' },
  'rose-gold-noir': { primary: '#291821', secondary: '#B77B75', accent: '#D7A39A', bg: '#F8F3F2', text: '#261C21', surface: '#FFFFFF' },
  'slate-azure': { primary: '#26394B', secondary: '#4C91B8', accent: '#80BCD9', bg: '#F3F7F9', text: '#1D2933', surface: '#FFFFFF' },
  'burgundy-champagne': { primary: '#552338', secondary: '#C7A477', accent: '#E1CBA8', bg: '#FAF6F0', text: '#30242A', surface: '#FFFFFF' },
  'obsidian-silver': { primary: '#171A20', secondary: '#AEB4BE', accent: '#D4D8DE', bg: '#F4F5F7', text: '#1B2028', surface: '#FFFFFF' },
  'coastal-azure': { primary: '#123B57', secondary: '#4B9EAA', accent: '#8BC9C8', bg: '#F2F8F8', text: '#17313B', surface: '#FFFFFF' },
  'tuscan-amber': { primary: '#5A3425', secondary: '#B77A3D', accent: '#D5A35F', bg: '#FAF3E9', text: '#30251E', surface: '#FFFFFF' }
};

const DEFAULT_THEME_KEY = 'navy-gold';

function getThemePalette(key) {
  return palettes[String(key || '').trim().toLowerCase()] || palettes[DEFAULT_THEME_KEY];
}

module.exports = {
  themeRegistry: palettes,
  DEFAULT_THEME_KEY,
  getThemePalette
};
