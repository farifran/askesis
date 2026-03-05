<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Celestial Toggle - Vanilla</title>
  </head>
  <body class="transition-colors duration-700 ease-in-out bg-slate-50 min-h-screen flex items-center justify-center overflow-hidden">
    <div class="text-center space-y-8">
      <h1 id="mode-text" class="text-2xl font-medium tracking-tight text-slate-800 transition-colors duration-700">
        Day Mode
      </h1>

      <div id="toggle-container" class="relative flex items-center justify-center cursor-pointer">
        <!-- SVG Definitions for Gradients and Filters -->
        <svg class="absolute w-0 h-0" aria-hidden="true">
          <defs>
            <linearGradient id="sun-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#fbbf24;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#f59e0b;stop-opacity:1" />
            </linearGradient>
            <linearGradient id="moon-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#e2e8f0;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#94a3b8;stop-opacity:1" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
        </svg>

        <!-- Toggle Track -->
        <div id="toggle-track" class="w-32 h-16 rounded-full border-2 border-slate-300 bg-slate-200 relative overflow-hidden transition-all duration-500">
          
          <!-- Stars (Hidden by default) -->
          <div id="stars" class="absolute inset-0 opacity-0 transition-opacity duration-500 pointer-events-none">
            <div class="absolute top-3 left-4 w-1 h-1 bg-white rounded-full opacity-40"></div>
            <div class="absolute top-10 left-8 w-0.5 h-0.5 bg-white rounded-full opacity-60"></div>
            <div class="absolute top-5 left-12 w-1 h-1 bg-white rounded-full opacity-30"></div>
            <div class="absolute top-8 right-10 w-1 h-1 bg-white rounded-full opacity-40"></div>
            <div class="absolute bottom-4 left-16 w-0.5 h-0.5 bg-white rounded-full opacity-50"></div>
          </div>

          <!-- Sliding Thumb -->
          <div id="toggle-thumb" class="absolute top-[2px] left-[2px] w-14 h-14 rounded-full bg-white flex items-center justify-center shadow-sm transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]">
            
            <!-- Sun Icon (Enhanced) -->
            <svg id="sun-icon" xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" class="transition-all duration-300 transform scale-100 rotate-0" style="filter: url(#glow);">
              <circle cx="12" cy="12" r="5" fill="url(#sun-gradient)"/>
              <g stroke="url(#sun-gradient)" stroke-width="2" stroke-linecap="round">
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </g>
            </svg>

            <!-- Moon Icon (Enhanced) -->
            <svg id="moon-icon" xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" class="absolute opacity-0 transition-all duration-300 transform scale-0 rotate-90" style="filter: url(#glow);">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" fill="url(#moon-gradient)"/>
              <!-- Craters -->
              <circle cx="8" cy="12" r="1.5" fill="#94a3b8" opacity="0.4"/>
              <circle cx="12" cy="16" r="1" fill="#94a3b8" opacity="0.4"/>
              <circle cx="14" cy="10" r="0.8" fill="#94a3b8" opacity="0.4"/>
            </svg>

          </div>
        </div>
      </div>
      
      <p id="hint-text" class="text-sm font-mono text-slate-500 opacity-50 transition-colors duration-700">
        Hover to toggle
      </p>
    </div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>

