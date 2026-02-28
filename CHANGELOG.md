# Oddity 1 — Feature Changelog

## Latest Update: Feb 27, 2026

### Dashboard Redesign & Profile System (Feb 27)
- ✅ **Profile Management**: Users now collect name during sign-up; displayed in dashboard with avatar
- ✅ **Personalized Greetings**: Rotating welcome text (5 variations) with user's first name
- ✅ **Profile Popover**: Clickable profile button (avatar + name) → popover with email, tier, sign-out
- ✅ **Tier Badge**: Visual indicator (FREE/PRO) on profile button
- ✅ **Refined Design**: Supabase-style aesthetic — warm light background, green accent, subtle borders, pill buttons
- ✅ **Badge Updates**: "OFF" badge when disabled, "!" when not signed in, clear when enabled
- ✅ **Sign-Up Name Field**: Name input in sign-up form (hidden in sign-in mode)

### Dark Mode (Feb 27)
- ✅ **Auto Theme Detection**: Detects system theme + page-level dark mode
- ✅ **Color Adjustment**: Annotation colors automatically adjusted for contrast (lighter highlights, inverted text)
- ✅ **Margin Note Adaptation**: User annotations adapt to detected theme
- ✅ **Persistent Styling**: Works seamlessly across all annotation types

### Streaming Chatbot Support (Feb 26-27)
- ✅ **ChatGPT Adapter**: Streaming detection via copy/edit button appearance
- ✅ **Claude Adapter**: Streaming detection via class markers and completion signals
- ✅ **Real-Time Annotation**: Annotations appear automatically as messages complete streaming
- ✅ **Fallback Stability**: MutationObserver debounce for non-streaming sites

### Margin Notes System (Feb 24-26)
- ✅ **User Annotations**: Add custom notes anywhere via FAB or context menu
- ✅ **Margin Display**: Notes appear in right-side margin with type icons
- ✅ **Edit/Delete Controls**: Full lifecycle management (create, edit, delete)
- ✅ **Persistent Storage**: Notes saved in `chrome.storage.local` per-page
- ✅ **Smart Scrolling**: Margin notes auto-scroll to stay visible with viewport

### PDF Export (Feb 24)
- ✅ **Full Export**: Download page with AI annotations + user notes as PDF
- ✅ **Preserved Layout**: Original content styling and structure maintained
- ✅ **Tier Gating**: Free tier has fixed subtitle; Pro tier allows custom
- ✅ **Annotation Embedding**: Both AI and manual annotations appear in PDF

### Visual & UX Enhancements (Feb 24-26)
- ✅ **Vivid Colors**: Updated annotation type color palette
- ✅ **Emphasis on Hover**: Stronger visual emphasis when hovering over annotations
- ✅ **Caveat Type Fix**: Fixed visual rendering bug for caveat annotations
- ✅ **Margin Note Position**: Notes positioned on right side (not left)
- ✅ **Contrast Improvements**: Better readability across all themes

### Auth & Error Handling (Feb 23-24)
- ✅ **Auth Badge**: Red "!" badge on extension icon when not signed in
- ✅ **Auth Toast**: In-page notification prompting sign-in when needed
- ✅ **Improved Feedback**: Better error messages and auth flow guidance
- ✅ **User Annotation Storage**: Secure storage of user-generated annotations with Supabase
- ✅ **Account Creation Flow**: Streamlined sign-up experience

### Core Annotation Engine (Feb 23)
- ✅ **Exact String Matching**: Fixed annotation targeting via text-quote selectors
- ✅ **Annotation Filter**: Advanced filtering for schema validation and fallback handling
- ✅ **TextQuoteSelector Resolver**: W3C standard precise text anchoring
- ✅ **Overlay DOM**: Optimized DOM structure for performance
- ✅ **Partial Fallback**: Returns partial annotation sets if some fail validation

---

## Architecture & Technical Improvements

### Extension Stack
- **Service Worker**: Message routing, auth management, adapter registry, API client
- **Content Script**: Text extraction, DOM stability detection, streaming support, rendering engine
- **Popup Dashboard**: Stats, controls, export, profile management (refined design)
- **Shadow DOM Popovers**: Fully isolated from host CSS
- **Overlay Layer**: High-performance annotation rendering via `getClientRects()`

### Backend
- **Express API**: Annotation generation, caching, user preferences, adapter registry
- **Supabase Auth**: Email/OAuth authentication with profile storage
- **OpenAI Integration**: Structured annotation generation with intensity levels
- **Rate Limiting**: Free (50/day) and Pro (500/day) tier enforcement
- **Annotation Filtering**: Schema validation and fallback annotation handling

### Database
- **Profiles Table**: User metadata (name, tier, preferences)
- **Annotation Cache**: AI annotations keyed by content hash + intensity (30-day TTL)
- **User Annotations**: Manual annotations per user per page
- **Site Adapters**: Remotely updateable extraction config (6 seeded sites)

---

## Supported Sites & Modes

| Site | Mode | Features |
|------|------|----------|
| ChatGPT | Streaming Adapter | Real-time annotations, copy/edit detection |
| Claude | Streaming Adapter | Real-time annotations, class-based completion detection |
| Medium | Readability | Article extraction, margin notes |
| Medium (subdomains) | Readability | Custom domain support |
| Substack | Readability | Newsletter extraction |

---

## Annotation Types

| Type | Visual | Use | Margin Note |
|------|--------|-----|-------------|
| Highlight | Yellow background | Key phrase | ✓ |
| Important | Teal underline | Important statement | ✓ |
| Question | Purple dotted + ? | Probing question | ✓ |
| Insight | Blue background | Why it matters | ✓ |
| Caveat | Orange wavy | Counterpoint | ✓ |
| Vocabulary | Green dotted | Term definition | ✓ |

---

## User Preferences

Stored per-user with automatic sync:
- **Enabled**: Global on/off toggle
- **Intensity**: Light / Default / Heavy
- **Visible Types**: Per-type visibility toggles
- **Disabled Sites**: Per-site disable list

---

## Known Limitations & Future Work

- [ ] Mobile support (currently Chrome desktop only)
- [ ] Multi-language annotation prompts
- [ ] Advanced search across all annotated content
- [ ] Real-time collaboration / sharing
- [ ] Browser sync across devices (planned with Supabase)
- [ ] Custom annotation types (future Pro feature)

---

## Testing Checklist

- [ ] Sign-up with name collection
- [ ] Profile popover (click button, verify email/tier)
- [ ] Rotating greetings (refresh popup multiple times)
- [ ] Badge states (not signed in = !, disabled = OFF)
- [ ] Dark mode on ChatGPT/GitHub/Medium
- [ ] ChatGPT streaming detection
- [ ] Claude streaming detection
- [ ] Margin notes (create, edit, delete)
- [ ] PDF export (includes all annotations)
- [ ] Intensity levels (Light/Default/Heavy show fewer/more annotations)
- [ ] Type filters (toggle on/off, verify UI updates)
- [ ] Auth badge + toast notification
- [ ] Sign-out from popover
- [ ] Long-form articles (lazy loading works)
- [ ] Manual annotation via FAB + context menu

---

## Deployment Checklist

- [ ] Backend prompts updated (not placeholders)
- [ ] Google OAuth configured in Supabase
- [ ] Backend deployed to Vercel
- [ ] `BACKEND_URL` updated in extension code
- [ ] Extension built for production
- [ ] Chrome Web Store submission ready
- [ ] Rate limits configured (Free/Pro tiers)

