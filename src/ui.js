  function ensureGlobalStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: absolute;
        z-index: 2147483646;
        min-width: 280px;
        max-width: ${PANEL_MAX_WIDTH}px;
        color: #18191c;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(24, 25, 28, 0.08);
        border-radius: 16px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.14);
        backdrop-filter: blur(16px);
        overflow: hidden;
      }

      #${PANEL_ID}.is-hidden {
        display: none;
      }

      #${PANEL_ID} .bes-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px 8px;
      }

      #${PANEL_ID} .bes-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: #18191c;
      }

      #${PANEL_ID} .bes-subtitle {
        color: #61666d;
        font-size: 12px;
      }

      #${PANEL_ID} .bes-body {
        max-height: 320px;
        overflow: auto;
        padding: 0 10px 10px;
      }

      #${PANEL_ID} .bes-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
        gap: 0;
      }

      #${PANEL_ID} .bes-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 8px 6px;
        border: 0;
        border-radius: 12px;
        background: transparent;
        cursor: pointer;
        color: inherit;
        transition: background-color 120ms ease, transform 120ms ease;
      }

      #${PANEL_ID} .bes-item:hover,
      #${PANEL_ID} .bes-item.is-selected {
        background: rgba(0, 161, 214, 0.12);
      }

      #${PANEL_ID} .bes-item:active {
        transform: translateY(1px);
      }

      #${PANEL_ID} .bes-thumb {
        display: grid;
        place-items: center;
        width: 54px;
        height: 54px;
        border-radius: 6px;
        background: rgba(24, 25, 28, 0.05);
        overflow: hidden;
      }

      #${PANEL_ID} .bes-thumb img {
        display: block;
        width: 48px;
        height: 48px;
        object-fit: contain;
      }

      #${PANEL_ID} .bes-thumb span {
        font-size: 18px;
        line-height: 1;
      }

      #${PANEL_ID} .bes-label {
        width: 100%;
        text-align: center;
        font-size: 12px;
        line-height: 1.25;
        color: #18191c;
        word-break: break-word;
      }

      #${PANEL_ID} .bes-empty {
        padding: 24px 16px 28px;
        text-align: center;
        font-size: 13px;
        color: #61666d;
      }
    `;

    document.head.appendChild(style);
  }

  function createOverlay(onSelect) {
    ensureGlobalStyle();

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = 'is-hidden';
    root.innerHTML = `
      <div class="bes-header">
        <h3 class="bes-title"></h3>
        <div class="bes-subtitle"></div>
      </div>
      <div class="bes-body">
        <div class="bes-grid"></div>
        <div class="bes-empty"></div>
      </div>
    `;

    const title = root.querySelector('.bes-title');
    const subtitle = root.querySelector('.bes-subtitle');
    const grid = root.querySelector('.bes-grid');
    const empty = root.querySelector('.bes-empty');

    document.body.appendChild(root);

    return {
      root,
      isInside(target) {
        return root.contains(target);
      },
      hide() {
        root.classList.add('is-hidden');
      },
      show(payload) {
        title.textContent = payload.title;
        subtitle.textContent = payload.subtitle || '';
        grid.textContent = '';

        if (payload.loading) {
          grid.style.display = 'none';
          empty.style.display = 'block';
          empty.textContent = '正在加载表情...';
        } else if (!payload.items.length) {
          grid.style.display = 'none';
          empty.style.display = 'block';
          empty.textContent = payload.emptyMessage;
        } else {
          grid.style.display = 'grid';
          empty.style.display = 'none';

          payload.items.forEach((entry, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `bes-item${index === payload.selectedIndex ? ' is-selected' : ''}`;
            button.dataset.code = entry.code;

            const thumb = document.createElement('div');
            thumb.className = 'bes-thumb';

            if (entry.imageUrl) {
              const image = document.createElement('img');
              image.src = entry.imageUrl;
              image.alt = entry.code;
              thumb.appendChild(image);
            } else {
              const text = document.createElement('span');
              text.textContent = entry.previewText || entry.label.slice(0, 2);
              thumb.appendChild(text);
            }

            const label = document.createElement('div');
            label.className = 'bes-label';
            label.textContent = entry.label;

            button.appendChild(thumb);
            button.appendChild(label);

            button.addEventListener('mousedown', (event) => {
              event.preventDefault();
            });

            button.addEventListener('click', (event) => {
              event.preventDefault();
              onSelect(entry);
            });

            grid.appendChild(button);
          });
        }

        const anchorRect = payload.anchorRect;
        const width = Math.min(PANEL_MAX_WIDTH, Math.max(280, Math.floor(anchorRect.width)));
        const left = clamp(
          anchorRect.left + window.scrollX + (anchorRect.width - width) / 2,
          window.scrollX + 8,
          window.scrollX + window.innerWidth - width - 8
        );
        const top = anchorRect.bottom + window.scrollY + 10;

        root.style.width = `${width}px`;
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
        root.classList.remove('is-hidden');
      },
    };
  }
