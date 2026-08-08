(() => {
  let auth = null;
  let activeUser = null;
  let activeListId = null;
  let listsRef = null;
  let listIndexRef = null;
  let listIndexEnabled = false;
  let listListenerRef = null;
  let settingsLogRef = null;
  let memberSortRef = null;
  let currentMemberSortMode = 'manual';
  let currentMemberSortDirection = 'desc';
  let excludeHistoricalFromSkillSort = false;
  let currentListEntries = [];
  let listOrderDraft = [];
  let pendingMemberTransfer = null;
  const sharedListSyncTimers = new Map();
  const sharedListSyncSignatures = new Map();
  const pendingSharedListSources = new Map();
  const sharedListMirrorCache = new Map();
  let accountPlayerLocations = new Map();
  let listMenuSignature = '';
  let memberRenderSignature = '';
  let vsModeActive = false;
  let vsSelectedKeys = [];
  const vsSelectionSnapshots = new Map();
  let activeWorkspaceIdentity = '';
  let workspaceAuthSession = 0;
  let connectionStatusRef = null;
  let sharedListView = null;

  const createListMenuSignature = entries => JSON.stringify(entries.map(([id, list]) => [
    id,
    String(list.name || ''),
    Number(list.order || 0),
    Number(list.createdAt || 0),
    Number.isFinite(Number(list.memberCount)) ? Number(list.memberCount) : Object.keys(list.members || {}).length
  ]));

  const createMemberRenderSignature = members => JSON.stringify(
    Object.entries(members || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => [
      key,
      Object.entries(member || {})
        .filter(([field]) => !['fetchedStats', 'autoName', 'autoNameUpdatedAt'].includes(field))
        .sort(([a], [b]) => a.localeCompare(b))
    ])
  );
  const optimizedPhotoMemberKeys = new Set();
  const PHOTO_DATA_TARGET_LENGTH = 40 * 1024;
  const compressStoredPhotoData = photoData => new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 240;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        let compact = canvas.toDataURL('image/jpeg', 0.72);
        if (compact.length > PHOTO_DATA_TARGET_LENGTH) compact = canvas.toDataURL('image/jpeg', 0.58);
        resolve(compact.length < photoData.length ? compact : '');
      } catch (_) { resolve(''); }
    };
    image.onerror = () => resolve('');
    image.src = photoData;
  });
  async function optimizeOversizedMemberPhotos(members) {
    if (!membersRef || sharedListView) return;
    const targetMembersRef = membersRef;
    const targetListId = activeListId;
    for (const [key, member] of Object.entries(members || {})) {
      const photoData = String(member?.photoData || '');
      const optimizationKey = `${targetListId}:${key}`;
      if (
        optimizedPhotoMemberKeys.has(optimizationKey)
        || photoData.length <= PHOTO_DATA_TARGET_LENGTH
        || !/^data:image\//i.test(photoData)
      ) continue;
      optimizedPhotoMemberKeys.add(optimizationKey);
      const compact = await compressStoredPhotoData(photoData);
      if (compact) {
        await targetMembersRef.child(key).child('photoData').set(compact)
          .catch(error => console.warn('Stored member photo compression failed', error));
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }

  function patchVisibleAutoNames(members) {
    Object.entries(members || {}).forEach(([key, member]) => {
      const card = document.querySelector(`.poster-card[data-member-key="${CSS.escape(key)}"]`);
      const container = card?.querySelector('.poster-name');
      if (!container) return;
      let tracked = container.querySelector('.poster-name-tracked');
      const autoName = String(member?.autoName || '').trim();
      if (member?.nameMode !== 'auto' && autoName) {
        if (!tracked) {
          tracked = document.createElement('span');
          tracked.className = 'poster-name-tracked';
          container.append(tracked);
        }
        tracked.textContent = autoName;
        tracked.title = `自動取得名：${autoName}`;
        container.classList.add('has-tracked-name');
      } else {
        tracked?.remove();
        container.classList.remove('has-tracked-name');
      }
      fitPosterCardNames(card);
    });
  }

  function fitPosterNameText(text, minimumPx) {
    if (!text) return;
    text.style.removeProperty('font-size');
    const row = text.parentElement;
    if (!row) return;
    const icon = row.querySelector('.poster-name-lock-icon,.poster-name-auto-icon');
    const rowStyle = getComputedStyle(row);
    const gap = parseFloat(rowStyle.columnGap || rowStyle.gap) || 0;
    const available = Math.max(1, row.clientWidth - (icon?.getBoundingClientRect().width || 0) - (icon ? gap : 0));
    const naturalWidth = text.scrollWidth;
    if (naturalWidth <= available) return;
    const baseSize = parseFloat(getComputedStyle(text).fontSize) || 16;
    text.style.fontSize = `${Math.max(minimumPx, baseSize * available / naturalWidth).toFixed(2)}px`;
  }

  function fitPosterCardNames(card) {
    if (!card) return;
    const mobile = document.body.classList.contains('kentomo-mobile-device')
      || window.matchMedia('(max-width: 600px)').matches;
    fitPosterNameText(card.querySelector('.poster-name-text'), mobile ? 8.5 : 10);
    fitPosterNameText(card.querySelector('.poster-name-tracked'), mobile ? 8 : 9);
  }
  window.fitPosterCardNames = fitPosterCardNames;
  let posterNameFitTimer = 0;
  let lastPosterGridWidth = 0;
  const refitPosterNamesForWidth = width => {
    if (!Number.isFinite(width) || Math.abs(width - lastPosterGridWidth) < 1) return;
    lastPosterGridWidth = width;
    clearTimeout(posterNameFitTimer);
    posterNameFitTimer = setTimeout(() => {
      document.querySelectorAll('.poster-card').forEach(fitPosterCardNames);
    }, 120);
  };
  const posterGridForNameFit = document.getElementById('posterGrid');
  if (posterGridForNameFit && typeof ResizeObserver === 'function') {
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width || posterGridForNameFit.clientWidth;
      refitPosterNamesForWidth(width);
    }).observe(posterGridForNameFit);
  } else {
    // Old browsers lack ResizeObserver. Orientation changes affect the usable
    // card width; ordinary mobile scroll/address-bar resizing does not.
    window.addEventListener('orientationchange', () => {
      refitPosterNamesForWidth(document.getElementById('posterGrid')?.clientWidth || 0);
    }, { passive: true });
  }

  function updateVsModeView() {
    const button = byId('vsModeToggleBtn');
    if (button) {
      button.classList.toggle('is-active', vsModeActive);
      button.textContent = vsModeActive
        ? (vsSelectedKeys.length >= 2 ? '⚔ VS比較中' : `⚔ 対戦相手を選択 ${vsSelectedKeys.length}/2`)
        : '⚔ VSモード β';
      button.setAttribute('aria-pressed', String(vsModeActive));
    }
    document.body.classList.toggle('vs-mode-active', vsModeActive);
    document.body.classList.toggle('vs-pair-ready', vsModeActive && vsSelectedKeys.length === 2);
    document.querySelectorAll('#posterGrid > .poster-card').forEach(card => {
      const selectionId = `${activeListId || ''}::${memberKeyFromCard(card)}`;
      const selectionIndex = vsSelectedKeys.indexOf(selectionId);
      const selected = selectionIndex >= 0;
      card.classList.toggle('vs-selected', vsModeActive && selected);
      card.classList.toggle('vs-dimmed', vsModeActive && vsSelectedKeys.length === 2 && !selected);
      card.setAttribute('aria-pressed', String(vsModeActive && selected));
      let marker = card.querySelector(':scope > .vs-selection-marker');
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'vs-selection-marker';
        marker.setAttribute('aria-hidden', 'true');
        card.appendChild(marker);
      }
      marker.textContent = selected ? `VS ${selectionIndex + 1}` : '';
      marker.hidden = !(vsModeActive && selected);
    });
  }

  function safeFilenamePart(value, fallback) {
    const cleaned = String(value || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ');
    return (cleaned || fallback).slice(0, 80);
  }

  function blobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('画像変換に失敗しました'));
      reader.readAsDataURL(blob);
    });
  }

  const exportAssetDataUrlCache = new Map();
  const exportAssetBlobCache = new Map();
  async function fetchOriginCleanExportBlob(source) {
    if (!source) throw new Error('画像URLがありません');
    let promise = exportAssetBlobCache.get(source);
    if (!promise) {
      promise = (async () => {
        const imageProxyBase = 'https://tight-bar-55c1.uracil123.workers.dev';
        const fetchUrl = /^https:\/\/ewgf\.gg\//i.test(source)
          ? `${imageProxyBase}/?imageUrl=${encodeURIComponent(source)}`
          : source;
        const response = await fetch(fetchUrl, { cache: 'force-cache', mode: 'cors' });
        if (!response.ok) throw new Error(`画像取得 HTTP ${response.status}`);
        const blob = await response.blob();
        if (!/^image\//i.test(blob.type)) throw new Error(`画像ではない応答 (${blob.type || 'unknown'})`);
        return blob;
      })();
      exportAssetBlobCache.set(source, promise);
      promise.catch(() => exportAssetBlobCache.delete(source));
    }
    return promise;
  }

  async function decodeOriginCleanExportImage(source) {
    const blob = await fetchOriginCleanExportBlob(source);
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch (error) {
        console.warn('ImageBitmap decode failed; using data URL fallback', source, error);
      }
    }
    const image = new Image();
    image.src = await blobAsDataUrl(blob);
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    return image;
  }

  async function inlineExportImages(root) {
    const imageProxyBase = 'https://tight-bar-55c1.uracil123.workers.dev';
    await Promise.all([...root.querySelectorAll('img')].map(async image => {
      const source = image.currentSrc || image.src || '';
      if (!source || source.startsWith('data:')) return;
      let dataUrlPromise = exportAssetDataUrlCache.get(source);
      if (!dataUrlPromise) {
        dataUrlPromise = (async () => {
          const fetchUrl = /^https:\/\/ewgf\.gg\//i.test(source)
            ? `${imageProxyBase}/?imageUrl=${encodeURIComponent(source)}`
            : source;
          const response = await fetch(fetchUrl, { cache: 'force-cache', mode: 'cors' });
          if (!response.ok) throw new Error(`カード画像を取得できませんでした (${response.status})`);
          return blobAsDataUrl(await response.blob());
        })();
        exportAssetDataUrlCache.set(source, dataUrlPromise);
        dataUrlPromise.catch(() => exportAssetDataUrlCache.delete(source));
      }
      image.removeAttribute('crossorigin');
      image.src = await dataUrlPromise;
      if (typeof image.decode === 'function') {
        try { await image.decode(); } catch (_) {}
      }
    }));
  }

  function drawImageWithObjectFit(context, image, width, height, fit) {
    const imageRatio = image.naturalWidth / image.naturalHeight;
    const boxRatio = width / height;
    let drawWidth = width;
    let drawHeight = height;
    let drawX = 0;
    let drawY = 0;
    if (fit === 'contain' ? imageRatio > boxRatio : imageRatio < boxRatio) {
      drawHeight = fit === 'contain' ? width / imageRatio : width / imageRatio;
      if (fit === 'cover') {
        drawHeight = height;
        drawWidth = height * imageRatio;
      }
    } else {
      drawWidth = fit === 'contain' ? height * imageRatio : width;
      if (fit === 'cover') drawHeight = width / imageRatio;
    }
    drawX = (width - drawWidth) / 2;
    drawY = (height - drawHeight) / 2;
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  }

  async function rasterizeExportImages(root) {
    for (const image of [...root.querySelectorAll('img')]) {
      if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
        throw new Error('カード内の画像を読み込めませんでした');
      }
      const cleanImage = new Image();
      cleanImage.src = image.src;
      if (typeof cleanImage.decode === 'function') await cleanImage.decode();
      else await new Promise((resolve, reject) => {
        cleanImage.onload = resolve;
        cleanImage.onerror = reject;
      });
      const rect = image.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || image.width || image.naturalWidth));
      const height = Math.max(1, Math.round(rect.height || image.height || image.naturalHeight));
      const computed = getComputedStyle(image);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      canvas.className = `${image.className} export-raster-image`;
      canvas.dataset.exportOriginalClass = image.className;
      canvas.dataset.exportFilter = computed.filter || 'none';
      canvas.dataset.exportOpacity = computed.opacity || '1';
      canvas.style.cssText = image.style.cssText;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      for (const property of [
        'display', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
        'min-width', 'max-width', 'min-height', 'max-height', 'flex', 'align-self',
        'margin', 'padding', 'border', 'border-radius', 'box-sizing', 'opacity',
        'filter', 'transform', 'vertical-align'
      ]) canvas.style.setProperty(property, computed.getPropertyValue(property));
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      const fit = computed.objectFit || 'fill';
      if (fit === 'cover' || fit === 'contain') drawImageWithObjectFit(context, cleanImage, width, height, fit);
      else context.drawImage(cleanImage, 0, 0, width, height);
      image.replaceWith(canvas);
    }
  }

  function copyExportBoxStyle(source, target, width, height) {
    const computed = getComputedStyle(source);
    for (const property of [
      'display', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
      'min-width', 'max-width', 'min-height', 'max-height', 'flex', 'align-self',
      'margin', 'padding', 'border', 'border-radius', 'box-sizing', 'opacity',
      'filter', 'transform', 'vertical-align'
    ]) target.style.setProperty(property, computed.getPropertyValue(property));
    target.style.width = `${width}px`;
    target.style.height = `${height}px`;
    return computed;
  }

  function replaceExportMediaWithBackgrounds(root) {
    for (const image of [...root.querySelectorAll('img')]) {
      if (!image.complete || !image.naturalWidth) throw new Error('カード画像の読込が完了していません');
      const rect = image.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || image.width || image.naturalWidth));
      const height = Math.max(1, Math.round(rect.height || image.height || image.naturalHeight));
      const replacement = document.createElement('span');
      replacement.className = image.className;
      const computed = copyExportBoxStyle(image, replacement, width, height);
      // html2canvasのCSS背景ではWebP/SVG data URLが空になる端末がある。
      // いったん安全なCanvasへ描き、必ずPNG data URLへ統一する。
      const pngCanvas = document.createElement('canvas');
      pngCanvas.width = Math.max(1, image.naturalWidth);
      pngCanvas.height = Math.max(1, image.naturalHeight);
      pngCanvas.getContext('2d').drawImage(image, 0, 0);
      const pngDataUrl = pngCanvas.toDataURL('image/png');
      replacement.style.backgroundImage = `url("${pngDataUrl}")`;
      replacement.style.backgroundRepeat = 'no-repeat';
      replacement.style.backgroundPosition = computed.objectPosition || 'center';
      replacement.style.backgroundSize = computed.objectFit === 'cover' ? 'cover'
        : computed.objectFit === 'contain' ? 'contain' : '100% 100%';
      image.replaceWith(replacement);
    }
    for (const sourceCanvas of [...root.querySelectorAll('canvas')]) {
      let dataUrl;
      try { dataUrl = sourceCanvas.toDataURL('image/png'); }
      catch (error) {
        console.warn('Skipped an unsafe card canvas', sourceCanvas.className, error);
        continue;
      }
      const rect = sourceCanvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || sourceCanvas.width));
      const height = Math.max(1, Math.round(rect.height || sourceCanvas.height));
      const replacement = document.createElement('span');
      replacement.className = sourceCanvas.className;
      copyExportBoxStyle(sourceCanvas, replacement, width, height);
      replacement.style.backgroundImage = `url("${dataUrl}")`;
      replacement.style.backgroundRepeat = 'no-repeat';
      replacement.style.backgroundPosition = 'center';
      replacement.style.backgroundSize = '100% 100%';
      sourceCanvas.replaceWith(replacement);
    }
  }

  function drawExportLayerImage(context, image, width, height, fit) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const imageRatio = sourceWidth / sourceHeight;
    const boxRatio = width / height;
    let drawWidth = width;
    let drawHeight = height;
    if (fit === 'contain') {
      if (imageRatio > boxRatio) drawHeight = width / imageRatio;
      else drawWidth = height * imageRatio;
    } else if (fit === 'cover') {
      if (imageRatio > boxRatio) drawWidth = height * imageRatio;
      else drawHeight = width / imageRatio;
    }
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  async function prepareSafeExportLayers(root, exportScale = 2) {
    const rootRect = root.getBoundingClientRect();
    const layers = [];
    const skipped = [];
    const media = [...root.querySelectorAll('img,canvas')];
    for (const element of media) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        element.remove();
        continue;
      }
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const scale = Math.max(1, Number(exportScale) || 2);
      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = width * scale;
      layerCanvas.height = height * scale;
      const context = layerCanvas.getContext('2d');
      const computed = getComputedStyle(element);
      const placeholder = document.createElement('span');
      placeholder.className = 'export-media-placeholder';
      copyExportBoxStyle(element, placeholder, width, height);
      placeholder.style.setProperty('background', 'transparent', 'important');
      placeholder.style.setProperty('background-image', 'none', 'important');
      placeholder.style.setProperty('visibility', 'hidden', 'important');
      placeholder.setAttribute('aria-hidden', 'true');
      let replacement = placeholder;
      try {
        if (element instanceof HTMLImageElement) {
          const source = element.currentSrc || element.src;
          // Fetch the Blob with CORS (EWGF through our restricted image proxy)
          // and decode it directly. This avoids Android Chromium tainting the
          // previous cross-origin -> data URL -> Image -> Canvas round trip.
          const cleanImage = await decodeOriginCleanExportImage(source);
          context.save();
          context.scale(scale, scale);
          drawExportLayerImage(context, cleanImage, width, height, computed.objectFit || 'fill');
          context.restore();
          if (element.closest('.player-platform-badge')) {
            // Brand SVGs are black source assets made white by CSS on screen.
            // Bake that white silhouette into the export because html2canvas
            // does not consistently reproduce filters on replacement canvases.
            context.save();
            context.globalCompositeOperation = 'source-in';
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
            context.restore();
          }
          if (typeof cleanImage.close === 'function') cleanImage.close();
        } else if (
          element.classList.contains('stat-pentagon-canvas')
          && element.dataset.pentagonValues
          && typeof window.drawStatPentagonCanvas === 'function'
        ) {
          window.drawStatPentagonCanvas(
            layerCanvas,
            JSON.parse(element.dataset.pentagonValues),
            { width, pixelRatio: scale }
          );
        } else {
          context.drawImage(element, 0, 0, layerCanvas.width, layerCanvas.height);
        }
        // Prove each layer is origin-clean before it can touch the final image.
        layerCanvas.toDataURL('image/png');
        // Put the clean canvas back into the same DOM position. html2canvas can
        // now preserve its true stacking order against labels and text.
        layerCanvas.className = `${element.className || ''} export-clean-media-canvas`.trim();
        copyExportBoxStyle(element, layerCanvas, width, height);
        if (element.closest('.player-platform-badge')) {
          layerCanvas.style.setProperty('filter', 'none', 'important');
        }
        layerCanvas.setAttribute('aria-hidden', 'true');
        replacement = layerCanvas;
      } catch (error) {
        skipped.push(element.className || element.tagName);
        console.warn('Quarantined a tainted export layer', element.className || element.tagName, error);
      } finally {
        // Keep the exact occupied box in the capture DOM. Removing media made
        // the pentagon panel collapse and invalidated every saved coordinate.
        element.replaceWith(replacement);
      }
    }
    layers.sort((a, b) => a.zIndex - b.zIndex);
    return { width: rootRect.width, height: rootRect.height, layers, skipped };
  }

  function drawSafeExportLayers(baseCanvas, snapshot) {
    if (!snapshot.width || !snapshot.height) return baseCanvas;
    const scaleX = baseCanvas.width / snapshot.width;
    const scaleY = baseCanvas.height / snapshot.height;
    let outputCanvas = baseCanvas;
    for (const layer of snapshot.layers) {
      // Composite into a disposable candidate. If this particular layer taints
      // it on a browser, discard the candidate and retain the last clean image.
      const candidate = document.createElement('canvas');
      candidate.width = outputCanvas.width;
      candidate.height = outputCanvas.height;
      const context = candidate.getContext('2d');
      context.drawImage(outputCanvas, 0, 0);
      context.save();
      context.globalAlpha = layer.opacity;
      context.filter = /\burl\(/i.test(layer.filter) ? 'none' : layer.filter;
      context.drawImage(layer.canvas, layer.x * scaleX, layer.y * scaleY, layer.width * scaleX, layer.height * scaleY);
      context.restore();
      try {
        candidate.toDataURL('image/png');
        outputCanvas = candidate;
      } catch (error) {
        snapshot.skipped.push(layer.label || 'media');
        console.warn('Quarantined a layer during final export composition', layer.label, error);
      }
    }
    return outputCanvas;
  }

  function stripExportCssMedia(root) {
    root.classList.add('export-no-css-media');
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const backgroundImage = getComputedStyle(element).backgroundImage || '';
      if (/\burl\(/i.test(backgroundImage)) element.style.setProperty('background-image', 'none', 'important');
      element.style.setProperty('mask-image', 'none', 'important');
      element.style.setProperty('-webkit-mask-image', 'none', 'important');
    }
  }

  async function captureOriginCleanExportBase(root, options) {
    let canvas = await window.html2canvas(root, options);
    try {
      canvas.toDataURL('image/png');
      return canvas;
    } catch (error) {
      if (!/tainted|security/i.test(String(error && error.message || error))) throw error;
      console.warn('Export base was tainted; retrying without CSS media effects');
      stripExportCssMedia(root);
      canvas = await window.html2canvas(root, {
        ...options,
        useCORS: false,
        allowTaint: false,
      });
      // Fail here, before clean image layers are composited, with a useful cause.
      try {
        canvas.toDataURL('image/png');
      } catch (_) {
        throw new Error('カード背景の外部画像を安全に変換できませんでした');
      }
      return canvas;
    }
  }

  function prepareExportOverlays(root) {
    const rootRect = root.getBoundingClientRect();
    if (!rootRect.width || !rootRect.height) return { width: 0, height: 0, layers: [] };
    const layers = [];
    for (const raster of root.querySelectorAll('canvas')) {
      try { raster.toDataURL('image/png'); }
      catch (error) {
        console.warn('Skipped a tainted export layer', raster.className, error);
        continue;
      }
      const rect = raster.getBoundingClientRect();
      if (!rect.width || !rect.height || !raster.width || !raster.height) continue;
      const bitmap = document.createElement('canvas');
      bitmap.width = raster.width;
      bitmap.height = raster.height;
      bitmap.getContext('2d').drawImage(raster, 0, 0);
      layers.push({
        bitmap,
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
        zIndex: Number.parseInt(getComputedStyle(raster).zIndex, 10) || 0,
        filter: raster.dataset.exportFilter || 'none',
        opacity: Number(raster.dataset.exportOpacity || 1),
        originalClass: raster.dataset.exportOriginalClass || raster.className
      });
    }
    layers.sort((a, b) => a.zIndex - b.zIndex);
    return { width: rootRect.width, height: rootRect.height, layers };
  }

  function compositeExportRasters(outputCanvas, snapshot) {
    if (!snapshot || !snapshot.width || !snapshot.height) return;
    const scaleX = outputCanvas.width / snapshot.width;
    const scaleY = outputCanvas.height / snapshot.height;
    const context = outputCanvas.getContext('2d');
    for (const layer of snapshot.layers) {
      const x = layer.x * scaleX;
      const y = layer.y * scaleY;
      const width = layer.width * scaleX;
      const height = layer.height * scaleY;
      context.save();
      context.globalAlpha = layer.opacity;
      context.filter = layer.filter;
      context.drawImage(layer.bitmap, x, y, width, height);
      context.restore();
      if (layer.originalClass.includes('avatar-main-character-fallback')) {
        const label = 'MAIN CHARACTER';
        const fontSize = Math.max(8, 8 * scaleX);
        context.save();
        context.font = `900 ${fontSize}px Inter, sans-serif`;
        const paddingX = 5 * scaleX;
        const labelHeight = 17 * scaleY;
        const labelWidth = context.measureText(label).width + paddingX * 2;
        const labelX = x + width - labelWidth - 7 * scaleX;
        const labelY = y + height - labelHeight - 7 * scaleY;
        context.fillStyle = 'rgba(0,0,0,.68)';
        context.beginPath();
        context.roundRect(labelX, labelY, labelWidth, labelHeight, labelHeight / 2);
        context.fill();
        context.strokeStyle = 'rgba(255,255,255,.42)';
        context.lineWidth = Math.max(1, scaleX);
        context.stroke();
        context.fillStyle = '#fff';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2);
        context.restore();
      }
    }
  }

  async function rasterizeExportSvgs(root) {
    for (const svg of [...root.querySelectorAll('.link-btn svg')]) {
      const rect = svg.getBoundingClientRect();
      const width = Math.max(14, Math.round(rect.width || 14));
      const height = Math.max(14, Math.round(rect.height || 14));
      const computed = getComputedStyle(svg);
      const svgClone = svg.cloneNode(true);
      svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgClone.setAttribute('width', String(width * 2));
      svgClone.setAttribute('height', String(height * 2));
      svgClone.style.color = computed.color;
      svgClone.querySelectorAll('path,circle,rect,polygon').forEach(shape => {
        if (!shape.getAttribute('fill') || shape.getAttribute('fill') === 'currentColor') {
          shape.setAttribute('fill', computed.color);
        }
      });
      const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svgClone))}`;
      const image = new Image();
      image.src = source;
      if (typeof image.decode === 'function') await image.decode();
      else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.display = 'block';
      canvas.style.margin = '0 auto 2px';
      canvas.className = 'export-raster-svg';
      canvas.dataset.exportOpacity = computed.opacity || '1';
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      svg.replaceWith(canvas);
    }
  }

  function rasterizeExportSkillBadge(root) {
    const badge = root.querySelector('.member-skill-rank-badge:not([hidden])');
    if (!badge) return;
    const rank = Number(badge.dataset.rank || 0);
    const heading = badge.querySelector('.member-skill-rank-heading')?.textContent?.trim()
      || badge.querySelector('strong')?.textContent?.trim() || '';
    const metric = badge.querySelector('em')?.textContent?.trim() || '';
    const width = Math.max(72, Math.round(badge.getBoundingClientRect().width || 78));
    const height = 60;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.className = 'member-skill-rank-export-canvas';
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.scale(scale, scale);
    const palettes = {
      1: ['#fff2a8', '#f6c744', '#ad7005', '#493000'],
      2: ['#ffffff', '#cbd5e1', '#778394', '#26303c'],
      3: ['#ffd0a3', '#c77a35', '#713814', '#3e1c08']
    };
    const colors = palettes[rank] || palettes[2];
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(.52, colors[1]);
    gradient.addColorStop(1, colors[2]);
    context.beginPath();
    context.roundRect(1, 1, width - 2, 50, 13);
    context.fillStyle = gradient;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(255,255,255,.9)';
    context.stroke();
    context.beginPath();
    context.moveTo(width / 2 - 12, 50);
    context.lineTo(width / 2 + 12, 50);
    context.lineTo(width / 2, 59);
    context.closePath();
    context.fillStyle = colors[2];
    context.fill();
    context.fillStyle = colors[3];
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '900 12px Inter, sans-serif';
    context.fillText(heading, width / 2, 18, width - 8);
    context.font = '900 10px Inter, sans-serif';
    context.fillText(metric, width / 2, 37, width - 8);
    badge.replaceWith(canvas);
  }

  async function exportPlayerCard(card) {
    if (!card || typeof window.html2canvas !== 'function') {
      showToast('画像保存機能を読み込めませんでした。再読み込みしてください');
      return;
    }
    const key = memberKeyFromCard(card);
    const member = window.currentMembersData && window.currentMembersData[key] || {};
    const cleanId = typeof cleanTekkenId === 'function' ? cleanTekkenId(member.gameId) : String(member.gameId || '');
    const capturedAt = new Date();
    const exportRoot = document.createElement('div');
    exportRoot.className = 'card-export-render-root';
    const clone = card.cloneNode(true);
    clone.classList.remove('vs-selected', 'vs-dimmed', 'card-reordering');
    clone.classList.add('card-export-capture');
    clone.style.setProperty('--rand-deg', '0');
    // PNGから操作専用UIを除外する。画像になった後は機能しないため、
    // プレイヤー情報とランキング表示だけを保存する。
    clone.querySelectorAll(
      '.card-reorder-handle,.vs-selection-marker,.links-grid,.card-admin-bar,.list-card-actions,.member-skill-rank-badge'
    ).forEach(element => element.remove());
    const timestamp = document.createElement('div');
    timestamp.className = 'card-export-timestamp';
    const capturedLabel = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(capturedAt).replace(/-/g, '/');
    timestamp.textContent = `撮影日時 ${capturedLabel} JST`;
    clone.appendChild(timestamp);
    const exportWidth = Math.max(1, Math.round(card.offsetWidth || card.getBoundingClientRect().width));
    exportRoot.style.width = `${exportWidth}px`;
    clone.style.width = `${exportWidth}px`;
    exportRoot.appendChild(clone);
    document.body.appendChild(exportRoot);
    const sourceCanvases = card.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, index) => {
      const source = sourceCanvases[index];
      if (!source) return;
      try {
        canvas.width = source.width;
        canvas.height = source.height;
        canvas.getContext('2d').drawImage(source, 0, 0);
      } catch (_) {}
    });
    showToast('カード画像を作成しています…');
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      // Replace every image/canvas with an origin-clean canvas in the same DOM
      // position so labels and text retain their native stacking order.
      const exportScale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
      const safeExportLayers = await prepareSafeExportLayers(clone, exportScale);
      const baseCanvas = await captureOriginCleanExportBase(clone, {
        // PNG の角や透過領域も、カードを見せるための背景色で確実に塗る。
        backgroundColor: document.body.classList.contains('theme-japanese') ? '#eee8da'
          : document.body.classList.contains('theme-modern') ? '#101827' : '#28170e',
        scale: exportScale,
        useCORS: true,
        allowTaint: false,
        logging: false
      });
      const canvas = drawSafeExportLayers(baseCanvas, safeExportLayers);
      // Some mobile Chromium builds intermittently reject HTMLCanvasElement.toBlob
      // even when the same canvas can be exported. Use the synchronous PNG data
      // URL path so the download does not depend on Blob serialization.
      const pngDataUrl = canvas.toDataURL('image/png');
      if (!pngDataUrl || pngDataUrl === 'data:,') throw new Error('PNGを作成できませんでした');
      const link = document.createElement('a');
      link.href = pngDataUrl;
      const date = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(capturedAt);
      link.download = `${safeFilenamePart(member.name, 'player')}-${safeFilenamePart(cleanId, 'no-id')}-${date}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      showToast(safeExportLayers.skipped.length
        ? `PNGで保存しました（安全に変換できない装飾 ${safeExportLayers.skipped.length}件を除外）`
        : 'プレイヤーカードをPNGで保存しました');
    } catch (error) {
      console.error('Card image export failed', error);
      showToast(`画像保存に失敗しました: ${error.message}`);
    } finally {
      exportRoot.remove();
    }
  }

  function exportPlayerCardFromButton(button, event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (vsModeActive) {
      showToast('VSモードを終了してからカード画像を保存してください');
      return;
    }
    const card = button?.closest('.poster-card');
    if (!card) {
      showToast('保存するプレイヤーカードを確認できませんでした');
      return;
    }
    exportPlayerCard(card);
  }
  window.exportPlayerCardFromButton = exportPlayerCardFromButton;

  function cleanVsClone(clone) {
    clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    clone.removeAttribute('id');
    clone.querySelectorAll('button, a, input, select, textarea').forEach(element => {
      element.tabIndex = -1;
      element.setAttribute('aria-hidden', 'true');
    });
    clone.querySelectorAll('.card-reorder-handle, .card-admin-bar, .list-card-actions').forEach(element => element.remove());
  }

  const VS_PENTAGON_AXES = [
    { key: 'attack', label: '攻撃', angle: -90, style: '猛攻型' },
    { key: 'technique', label: '技術', angle: -18, style: '技巧派' },
    { key: 'appeal', label: '魅力', angle: 54, style: '華麗型' },
    { key: 'spirit', label: '精神', angle: 126, style: '不屈型' },
    { key: 'defense', label: '防御', angle: 198, style: '鉄壁型' }
  ];
  const VS_COMBAT_AXES = VS_PENTAGON_AXES.filter(axis => axis.key !== 'appeal');
  const COMPLETION_AXIS_THRESHOLD = 97;
  const VS_UNCERTAIN_COMPONENTS = new Set(['respect', 'ambition', 'fairness']);
  const VS_SPIRIT_COMPONENTS = new Set(['closeBattles', 'comeback', 'fightingSpirit', 'concentration']);
  const VS_COMPONENT_GROUPS = [
    { key: 'attackComponents', items: [['attackFrequency', '手数', '攻撃を多く出す傾向'], ['heavyDamage', '大ダメージ', '大きなリターンを取る傾向'], ['aggressiveness', '積極性', '攻撃をヒットやカウンターへ結び付ける傾向'], ['dominance', '圧倒', '優勢な流れを維持して押し切る傾向']] },
    { key: 'defenseComponents', items: [['block', 'ガード', 'ガードで受け止める傾向'], ['evasion', '回避', '移動やしゃがみで相手の技をスカさせる傾向'], ['throwEscape', '投げ抜け', '投げに対応する傾向'], ['composure', '冷静', '守勢でも慌てず崩れにくい傾向']] },
    { key: 'techniqueComponents', items: [['accuracy', '精度', '自分の技がスカになりにくい傾向'], ['judgement', '判断力', '状況や距離に合った確定反撃を選ぶ傾向'], ['retaliation', '切り返し', '守りから反撃へつなげる傾向'], ['stageUse', 'ステージ活用', '壁や床ギミックを活かす傾向']] },
    { key: 'spiritComponents', items: [['closeBattles', '接戦', '体力差の小さい接戦で粘る傾向'], ['comeback', '逆境', '不利状況から巻き返す傾向'], ['fightingSpirit', '闘志', '苦しい状況でも攻め返す傾向'], ['concentration', '集中力', '終盤まで判断を崩しにくい傾向']] },
    { key: 'appealComponents', items: [['versatility', '多彩', '技や二択を幅広く使う傾向'], ['ambition', '向上心', '勝負への姿勢に関する指標（詳細定義未公開）'], ['respect', '敬意', '対戦姿勢に関する指標（詳細定義未公開）'], ['fairness', '正々堂々', '対戦姿勢に関する指標（詳細定義未公開）']] }
  ];
  const vsComponents = pentagon => VS_COMPONENT_GROUPS.flatMap(group =>
    group.items.map(([key, label, meaning]) => ({ key, label, meaning, value: Number(pentagon?.[group.key]?.[key]) }))
  ).filter(item => Number.isFinite(item.value));
  const vsComponentMap = pentagon => Object.fromEntries(vsComponents(pentagon).map(item => [item.key, item.value]));
  function vsPentagonBattleProfile(pentagon) {
    if (!validVsPentagon(pentagon)) return null;
    const axes = VS_COMBAT_AXES.map(axis => Number(pentagon[axis.key]));
    const attack = Number(pentagon.attack);
    const defense = Number(pentagon.defense);
    const technique = Number(pentagon.technique);
    const spirit = Number(pentagon.spirit);
    const appeal = Number(pentagon.appeal);
    const components = vsComponentMap(pentagon);
    return {
      axes,
      attack,
      defense,
      technique,
      spirit,
      appeal,
      components,
      elite: axes.every(value => value >= 75),
      nearPerfect: axes.every(value => value >= 85),
      perfectAttack: attack >= COMPLETION_AXIS_THRESHOLD,
      perfectDefense: defense >= COMPLETION_AXIS_THRESHOLD,
      perfectTechnique: technique >= COMPLETION_AXIS_THRESHOLD,
      perfectSpirit: spirit >= COMPLETION_AXIS_THRESHOLD,
      perfectAppeal: appeal >= COMPLETION_AXIS_THRESHOLD,
      defenseLed: defense > attack,
      attackAllIn: attack >= 78 && defense <= 52,
      attackHeavy: (attack >= 78 && defense <= 52) || attack - defense >= 35,
      lowOffenseFlow: components.aggressiveness <= 10 || components.dominance <= 10,
      lowThrowEscape: components.throwEscape <= 8,
      veryLowThrowEscape: components.throwEscape <= 5,
      lowStageUse: components.stageUse <= 10,
      lowCloseBattles: components.closeBattles <= 12,
      lowFightingSpirit: components.fightingSpirit <= 10,
      lowJudgement: components.judgement <= 12,
      clutchSpirit: components.closeBattles >= 20 && components.comeback >= 20,
      lateFocus: components.fightingSpirit >= 20 && components.concentration >= 20,
      preciseEvasion: components.evasion >= 20 && components.accuracy >= 20,
      steadyDefense: components.block >= 20 && components.composure >= 20,
      sustainedOffense: components.aggressiveness >= 20 && components.dominance >= 20
    };
  }
  function vsPentagonForecastAdjustment(players) {
    const profiles = players.map(player => vsPentagonBattleProfile(player.stats?.statPentagon));
    const requiredComponents = ['attackFrequency', 'aggressiveness', 'dominance', 'block', 'evasion', 'composure'];
    if (profiles.some(profile => !profile
      || requiredComponents.some(key => !Number.isFinite(profile.components[key])))) {
      return { value: 0, available: false };
    }
    const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    // Pentagon values describe tendencies rather than a direct skill rating.
    // Appeal is excluded, and Spirit receives half weight because its calculation
    // is less directly observable than Attack, Defense, and Technique.
    const combatScore = profile =>
      (profile.attack + profile.defense + profile.technique + profile.spirit * .5) / 3.5;
    const axisSignal = Math.max(-1.2, Math.min(1.2,
      (combatScore(profiles[0]) - combatScore(profiles[1])) * .035
    ));
    const offenseFlow = profile => average([
      profile.components.attackFrequency,
      profile.components.aggressiveness,
      profile.components.dominance
    ]);
    const resistance = profile => average([
      profile.components.block,
      profile.components.evasion,
      profile.components.composure
    ]);
    const clashSignal = Math.max(-.8, Math.min(.8,
      ((offenseFlow(profiles[0]) - resistance(profiles[1]))
        - (offenseFlow(profiles[1]) - resistance(profiles[0]))) * .04
    ));
    return { value: axisSignal + clashSignal, available: true, profiles };
  }
  function vsCombatSubtypeText(pentagon) {
    const combatAxes = VS_COMBAT_AXES.map(axis => ({
      key: axis.key,
      label: axis.label,
      value: Number(pentagon?.[axis.key])
    })).filter(axis => Number.isFinite(axis.value)).sort((a, b) => b.value - a.value);
    if (combatAxes.length < 4) return '';
    const top = combatAxes[0];
    const second = combatAxes[1];
    if (top.value - combatAxes[combatAxes.length - 1].value <= 5) {
      return '特定方向へ寄りすぎない均衡タイプ。';
    }
    const singleAxisTypes = {
      attack: '攻めを軸にするタイプ',
      defense: '守備を軸にするタイプ',
      technique: '精度と状況対応を軸にするタイプ',
      spirit: '勝負強さを軸にするタイプ'
    };
    const pairTypes = {
      'attack|defense': '攻守の切り替えを軸にするタイプ',
      'attack|spirit': '攻めと勝負所の粘りを両立するタイプ',
      'attack|technique': '技術を軸に攻めのリターンを伸ばすタイプ',
      'defense|spirit': '受けの安定感と粘りを軸にするタイプ',
      'defense|technique': '守りと状況対応を軸にするタイプ',
      'spirit|technique': '技術と勝負強さを軸にするタイプ'
    };
    const tripleTypes = {
      'attack|defense|spirit': '攻守と勝負所の強さを兼ね備えるタイプ',
      'attack|defense|technique': '攻め・守り・状況対応が高水準で噛み合うタイプ',
      'attack|spirit|technique': '技術を土台に攻めと勝負強さを両立するタイプ',
      'defense|spirit|technique': '守り・状況対応・勝負強さを高水準で備えるタイプ'
    };
    const nearTop = combatAxes.filter(axis => top.value - axis.value <= 5);
    const nearTopKey = nearTop.map(axis => axis.key).sort().join('|');
    const nearTopType = nearTop.length >= 3
      ? tripleTypes[nearTopKey]
      : pairTypes[nearTopKey];
    if (top.value >= COMPLETION_AXIS_THRESHOLD) {
      const supportingAxes = nearTop.slice(1);
      if (supportingAxes.length) {
        return `${top.label}が完成域に達し、${supportingAxes.map(axis => axis.label).join('・')}も同時に高水準な、${nearTopType || singleAxisTypes[top.key]}。`;
      }
      return `${top.label}が完成域に達した、${singleAxisTypes[top.key]}。`;
    }
    if (nearTop.length >= 3 && nearTopType) {
      return `${nearTop.map(axis => axis.label).join('・')}が高い、${nearTopType}。`;
    }
    const attackAxis = combatAxes.find(axis => axis.key === 'attack');
    const techniqueAxis = combatAxes.find(axis => axis.key === 'technique');
    if (attackAxis?.value >= 80 && techniqueAxis?.value >= 80) {
      return '攻撃・技術がともに高い、技術を攻めのリターンへ結び付けるタイプ。';
    }
    let subtype = singleAxisTypes[top.key];
    if (top.value - second.value <= 5) {
      const pairKey = [top.key, second.key].sort().join('|');
      subtype = pairTypes[pairKey] || subtype;
      return `${top.label}・${second.label}が高い、${subtype}。`;
    }
    return `${top.label}が最も高い、${subtype}。`;
  }
  function vsPerfectAxesText(pentagon, excludeAttack = false) {
    const perfectCombatLabels = [
      ['attack', '攻撃'],
      ['defense', '防御'],
      ['technique', '技術'],
      ['spirit', '精神']
    ].filter(([key]) => !(excludeAttack && key === 'attack') && Number(pentagon?.[key]) >= COMPLETION_AXIS_THRESHOLD)
      .map(([, label]) => label);
    const phrases = [];
    if (perfectCombatLabels.length >= 2) {
      phrases.push(`${perfectCombatLabels.join('・')}が同時に完成域にあり、複数の強みがはっきり表れています。`);
    } else if (perfectCombatLabels.length === 1) {
      phrases.push(`${perfectCombatLabels[0]}指標が完成域に達しています。`);
    }
    if (Number(pentagon?.appeal) >= COMPLETION_AXIS_THRESHOLD) {
      phrases.push(`${perfectCombatLabels.length ? '魅力指標も' : '魅力指標が'}完成域です。公式の算出定義は非公開のため、対戦姿勢に関する良好な傾向として表示します。`);
    }
    return phrases.join(' ');
  }
  const vsPerfectCombatLabels = profile => [
    ['perfectAttack', '攻撃'],
    ['perfectDefense', '防御'],
    ['perfectTechnique', '技術'],
    ['perfectSpirit', '精神']
  ].filter(([key]) => profile?.[key]).map(([, label]) => label);
  function vsPentagonArchetype(pentagon) {
    const axes = VS_COMBAT_AXES.map(axis => Number(pentagon?.[axis.key]));
    if (axes.every(Number.isFinite) && axes.every(value => value >= 85)) {
      return '戦闘四指標すべてが極めて高水準。攻守と勝負強さに隙がほとんどない超万能型。';
    }
    if (axes.every(Number.isFinite) && axes.every(value => value >= 75)) {
      const subtype = axes.some(value => value >= COMPLETION_AXIS_THRESHOLD) ? '' : vsCombatSubtypeText(pentagon);
      return `戦闘四指標すべてが高水準の、穴が少ない万能型。${subtype}`;
    }
    const attack = Number(pentagon?.attack);
    const defense = Number(pentagon?.defense);
    const technique = Number(pentagon?.technique);
    if (attack >= 80 && technique >= 80) {
      if (Number.isFinite(defense) && defense > attack) {
        return '守備を軸にしながら、攻撃・技術も高水準に備える総合型。';
      }
      const lead = attack >= COMPLETION_AXIS_THRESHOLD
        ? '完成域の攻めを高い技術が支える攻撃・技術型。'
        : '攻撃・技術がともに高い攻撃・技術型。';
      if (Number.isFinite(defense) && attack - defense >= 25 && technique - defense >= 25) {
        return defense >= 50
          ? `${lead}守りにも一定の対応力はありますが、配分は明確に攻め寄りです。`
          : `${lead}守勢には攻略の糸口があります。`;
      }
      return Number.isFinite(defense) && defense >= 80
        ? `${lead}防御も高水準で、攻め一辺倒ではありません。`
        : lead;
    }
    if (attack >= COMPLETION_AXIS_THRESHOLD) {
      return '攻撃指標が完成域にあり、攻めを起点に試合を支配する力が際立っています。';
    }
    if (attack >= 78 && defense <= 52) {
      return '攻撃全振り型。先に流れを握る強さがある一方、守勢には攻略の糸口があります。';
    }
    if (Number.isFinite(attack) && Number.isFinite(defense) && attack - defense >= 35) {
      return defense >= 50
        ? '攻撃全振り型に近いバランス。守りも一定水準にありますが、最大の武器は圧倒的な攻めです。'
        : '攻撃偏重型。先に流れを握る強さがある一方、守勢には攻略の糸口があります。';
    }
    if (Number.isFinite(attack) && Number.isFinite(defense) && defense > attack) {
      return '守備指標が攻撃指標を上回る、やや防御型。受け止めて切り返す展開が持ち味です。';
    }
    return '';
  }
  function vsSpiritRead(pentagon) {
    const map = vsComponentMap(pentagon);
    let strength = '';
    if (map.closeBattles >= 20 && map.comeback >= 20) {
      strength = '精神面では、接戦と逆境の両方で勝負を残す傾向。';
    } else if (map.fightingSpirit >= 20 && map.concentration >= 20) {
      strength = '精神面では、苦しい状況でも勝負を手放さず終盤まで粘る傾向。';
    } else if (map.closeBattles >= 20) {
      strength = '精神面では、競ったラウンドで粘る傾向。';
    } else if (map.comeback >= 20) {
      strength = '精神面では、先行された展開から巻き返す傾向。';
    } else if (map.fightingSpirit >= 20) {
      strength = '精神面では、苦しい状況でも攻め返す傾向。';
    } else if (map.concentration >= 20) {
      strength = '精神面では、終盤まで判断を保つ傾向。';
    }
    const lowCloseBattles = map.closeBattles <= 12;
    const lowFightingSpirit = map.fightingSpirit <= 10;
    let focus = '';
    if (lowCloseBattles && lowFightingSpirit) {
      focus = '一方で、競った終盤の勝ち切りと、低体力・劣勢時の攻め返しが焦点。';
    } else if (lowCloseBattles) {
      focus = '競った終盤を勝ち切れるかが焦点。';
    } else if (lowFightingSpirit) {
      focus = '低体力・劣勢時に残ったリソースから攻め返せるかが焦点。';
    }
    return [strength, focus].filter(Boolean).join(' ');
  }
  function vsTechniqueRead(pentagon) {
    const map = vsComponentMap(pentagon);
    return map.judgement <= 12
      ? '技術面では、ガード後の確定反撃を状況・距離に合わせて選べるかが焦点。'
      : '';
  }
  function vsProfileFocusSummary(profile) {
    if (!profile || profile.elite) return [];
    const focusNotes = [];
    if (profile.lowOffenseFlow) focusNotes.push({ label: '攻めの成立・継続', priority: 78 });
    if (profile.lowThrowEscape) {
      focusNotes.push({ label: '投げ対応', priority: profile.veryLowThrowEscape ? 100 : 88 });
    }
    if (profile.lowStageUse) focusNotes.push({ label: 'ステージ活用', priority: 45 });
    if (profile.lowJudgement) focusNotes.push({ label: '確定反撃の技選択', priority: 95 });
    if (profile.lowCloseBattles && profile.lowFightingSpirit) {
      focusNotes.push({ label: '接戦の勝ち切り・劣勢時の攻め返し', priority: 84 });
    } else if (profile.lowCloseBattles) {
      focusNotes.push({ label: '接戦の勝ち切り', priority: 70 });
    } else if (profile.lowFightingSpirit) {
      focusNotes.push({ label: '劣勢時の攻め返し', priority: 76 });
    }
    focusNotes.sort((a, b) => b.priority - a.priority);
    if (focusNotes.length >= 3) {
      return [
        `優先課題：${focusNotes.slice(0, 2).map(item => item.label).join('・')}`,
        `次段階：${focusNotes.slice(2).map(item => item.label).join('・')}`
      ];
    }
    return focusNotes.map(item => `${item.label}が焦点`);
  }
  function buildVsPentagonRead(players) {
    const componentSets = players.map(player => vsComponents(player.stats?.statPentagon));
    if (componentSets.some(items => items.length < 20)) {
      const summaries = players.map(player => {
        const pentagon = player.stats?.statPentagon;
        const profile = vsPentagonBattleProfile(pentagon);
        const archetype = vsPentagonArchetype(pentagon);
        const perfectAxesRead = vsPerfectAxesText(pentagon, Boolean(profile?.perfectAttack && !profile?.elite));
        const summary = [archetype, perfectAxesRead].filter(Boolean).join(' ');
        return summary ? `${vsDisplayName(player)}：${summary}` : '';
      }).filter(Boolean);
      return { available: false, lines: [...summaries, '五角形は「攻撃・防御・技術・精神・魅力」の総合傾向です。内訳が揃うと、さらに詳しく読み解けます。'] };
    }
    const lines = players.map((player, index) => {
      const candidates = componentSets[index].filter(item => !VS_UNCERTAIN_COMPONENTS.has(item.key));
      const top = [...candidates].sort((a, b) => b.value - a.value).slice(0, 2);
      const pentagon = player.stats?.statPentagon;
      const profile = vsPentagonBattleProfile(pentagon);
      const archetype = vsPentagonArchetype(pentagon);
      const perfectAxesRead = vsPerfectAxesText(pentagon, Boolean(profile?.perfectAttack && !profile?.elite));
      const spiritRead = profile?.elite ? '' : vsSpiritRead(pentagon);
      const techniqueRead = profile?.elite ? '' : vsTechniqueRead(pentagon);
      const topIsMeaningful = top[0].value >= 14
        && top[0].value - Math.min(...candidates.map(item => item.value)) >= 3;
      const meaningItem = top.find(item => !VS_SPIRIT_COMPONENTS.has(item.key)) || top[0];
      const componentSummary = profile?.elite
        ? ''
        : (topIsMeaningful
          ? `${top.map(item => item.label).join('・')}${top[0].value >= 18 ? 'が中心' : 'が比較的高め'}。`
          : '各内訳に大きな突出はありません。');
      const primaryMeaning = !profile?.elite
        && topIsMeaningful
        && !(spiritRead && VS_SPIRIT_COMPONENTS.has(meaningItem.key))
        ? `${meaningItem.meaning}。`
        : '';
      return `${vsDisplayName(player)}：${archetype ? `${archetype} ` : ''}${perfectAxesRead ? `${perfectAxesRead} ` : ''}${componentSummary}${primaryMeaning}${spiritRead ? ` ${spiritRead}` : ''}${techniqueRead ? ` ${techniqueRead}` : ''}`;
    });
    const pairs = [
      ['attackFrequency', 'block', '手数とガードのせめぎ合い'],
      ['aggressiveness', 'evasion', '有効打・カウンターと回避の読み合い'],
      ['heavyDamage', 'composure', '大きなリターンと守勢での冷静さの勝負'],
      ['versatility', 'judgement', '多彩な技・二択と確定反撃判断の勝負'],
      ['dominance', 'comeback', '押し切る力と逆境からの巻き返しの衝突'],
      ['closeBattles', 'concentration', '接戦力と終盤の集中力の勝負']
    ];
    const byKey = componentSets.map(items => Object.fromEntries(items.map(item => [item.key, item.value])));
    const clashes = pairs.map(([leftKey, rightKey, text]) => ({
      strength: Math.max(byKey[0][leftKey] + byKey[1][rightKey], byKey[1][leftKey] + byKey[0][rightKey]),
      text
    })).filter(item => item.strength >= 38).sort((a, b) => b.strength - a.strength);
    if (clashes[0]) lines.push(`注目構図：${clashes[0].text}。`);
    return { available: true, lines };
  }
  const validVsPentagon = value => value
    && VS_PENTAGON_AXES.every(axis => Number.isFinite(Number(value[axis.key])));
  const vsPlayerData = key => {
    const snapshot = vsSelectionSnapshots.get(key);
    if (snapshot) return snapshot.player;
    const memberKey = String(key || '').includes('::') ? String(key).split('::').slice(1).join('::') : key;
    const member = window.currentMembersData?.[memberKey] || {};
    return { key: memberKey, member, stats: memberStats(member) };
  };
  const vsDisplayName = player => String(player.member?.name || player.member?.gameId || 'PLAYER').trim();
  const topVsAxis = pentagon => validVsPentagon(pentagon)
    ? VS_COMBAT_AXES.reduce((best, axis) =>
        Number(pentagon[axis.key]) > Number(pentagon[best.key]) ? axis : best
      , VS_COMBAT_AXES[0])
    : null;
  const vsMatchupRecord = (player, opponent) => {
    const target = String(opponent.stats?.mainChar || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!target) return null;
    const entry = Object.entries(player.stats?.characterMatchups || {}).find(([character]) =>
      String(character).toLowerCase().replace(/[^a-z0-9]/g, '') === target
    );
    if (!entry) return null;
    const games = Number(entry[1]?.games) || 0;
    const winRate = Number(entry[1]?.winRate);
    return games > 0 && Number.isFinite(winRate) ? { character: entry[0], games, winRate } : null;
  };
  function calculateVsForecast(players) {
    const ratings = players.map(player => {
      const value = player.stats?.ratingMu;
      return value === null || value === undefined || value === '' ? NaN : Number(value);
    });
    const usable = ratings.every(Number.isFinite);
    if (!usable) {
      return { left: 50, right: 50, confidence: 'データ不足', verdict: 'レートが揃っていないため互角表示', usable: false };
    }
    const rawLeft = 100 / (1 + Math.pow(10, (ratings[1] - ratings[0]) / 400));
    const winRates = players.map(player => {
      const value = player.stats?.rankedWinRate;
      return value === null || value === undefined || value === '' ? NaN : Number(value);
    });
    const games = players.map(player => Math.max(0, Number(player.stats?.mainCharGames || 0)));
    const winRateUsable = winRates.every(Number.isFinite) && games.every(value => value >= 30);
    // Overall win rate partly overlaps with rating and depends on opponent pool.
    // Keep it as a deliberately small, sample-size-weighted supporting signal.
    const winRateReliability = winRateUsable
      ? Math.min(games[0] / (games[0] + 200), games[1] / (games[1] + 200))
      : 0;
    const winRateAdjustment = winRateUsable
      ? Math.max(-3, Math.min(3, (winRates[0] - winRates[1]) * .18 * winRateReliability))
      : 0;
    const matchupRecords = [vsMatchupRecord(players[0], players[1]), vsMatchupRecord(players[1], players[0])];
    const matchupSignals = matchupRecords.map(record => record
      ? (record.winRate - 50) * Math.min(1, record.games / 20)
      : 0
    );
    // Character matchup is volatile and overlaps with player strength, so cap its
    // influence to four percentage points even when both sides have enough games.
    const matchupAdjustment = Math.max(-4, Math.min(4, (matchupSignals[0] - matchupSignals[1]) * .12));
    const pentagonForecast = vsPentagonForecastAdjustment(players);
    const pentagonAdjustment = pentagonForecast.value;
    const left = Math.round(Math.max(1, Math.min(99, rawLeft + winRateAdjustment + matchupAdjustment + pentagonAdjustment)));
    const right = 100 - left;
    const historical = players.some(player => player.stats?.ratingIsHistorical);
    const experienced = players.every(player => Number(player.stats?.leaderboardGames || 0) >= 50);
    const confidence = historical ? '低（過去参考値を含む）' : (experienced ? '高' : '中');
    const gap = Math.abs(left - right);
    const leader = left >= right ? vsDisplayName(players[0]) : vsDisplayName(players[1]);
    const verdict = Math.max(left, right) >= 90 ? `${leader} 90% OVER予測`
      : gap <= 4 ? 'データ上は完全互角'
      : gap <= 12 ? `${leader}がわずかに優勢`
      : gap <= 30 ? `${leader}がやや優勢`
      : `${leader}が優勢`;
    return {
      left, right, confidence, verdict, usable: true, ratings,
      ratingOnlyLeft: Math.round(rawLeft),
      winRates,
      winRateUsable,
      winRateAdjustment,
      matchupRecords,
      matchupAdjustment,
      pentagonAdjustment,
      pentagonForecast,
      basisText: matchupRecords.some(Boolean)
        ? `Wavu μを主軸に、メイン勝率、EWGF今季ランク戦の対${players[1].stats?.mainChar || '相手キャラ'}／対${players[0].stats?.mainChar || '相手キャラ'}戦績、戦闘系ペンタゴンを小さく補正した目安です。`
        : (winRateUsable
          ? 'Wavu μを主軸に、メインキャラ勝率と戦闘系ペンタゴンを小さく補正した目安です。'
          : (pentagonForecast.available
            ? 'Wavu μを主軸に、戦闘系ペンタゴンを最大約2ptだけ補正した目安です。'
            : 'Wavu μによる目安です。'))
    };
  }
  function drawVsPentagon(canvas, players) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.round(rect.width || 360));
    const height = Math.max(260, Math.round(rect.height || 300));
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const centerX = width / 2;
    const centerY = height / 2 + 6;
    const radius = Math.min(width * .29, height * .31);
    const point = (axis, scale = 1) => {
      const radians = axis.angle * Math.PI / 180;
      return {
        x: centerX + Math.cos(radians) * radius * scale,
        y: centerY + Math.sin(radians) * radius * scale
      };
    };
    const polygon = (points, fill, stroke, lineWidth = 1) => {
      context.beginPath();
      points.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y));
      context.closePath();
      if (fill) { context.fillStyle = fill; context.fill(); }
      if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
    };
    for (let level = 1; level <= 4; level += 1) {
      polygon(VS_PENTAGON_AXES.map(axis => point(axis, level / 4)), null, 'rgba(203,213,225,.2)');
    }
    VS_PENTAGON_AXES.forEach(axis => {
      const outer = point(axis);
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(outer.x, outer.y);
      context.strokeStyle = 'rgba(203,213,225,.18)';
      context.stroke();
    });
    const colors = [
      { fill: 'rgba(251,71,107,.27)', stroke: '#fb476b', glow: 'rgba(251,71,107,.62)' },
      { fill: 'rgba(45,212,191,.24)', stroke: '#2dd4bf', glow: 'rgba(45,212,191,.58)' }
    ];
    players.forEach((player, index) => {
      if (!validVsPentagon(player.stats?.statPentagon)) return;
      const points = VS_PENTAGON_AXES.map(axis =>
        point(axis, Math.max(0, Math.min(100, Number(player.stats.statPentagon[axis.key]))) / 100)
      );
      context.save();
      context.shadowColor = colors[index].glow;
      context.shadowBlur = 10;
      polygon(points, colors[index].fill, colors[index].stroke, 2.5);
      context.restore();
      context.fillStyle = colors[index].stroke;
      points.forEach(item => {
        context.beginPath();
        context.arc(item.x, item.y, 3, 0, Math.PI * 2);
        context.fill();
      });
    });
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#f8fafc';
    VS_PENTAGON_AXES.forEach(axis => {
      const label = point(axis, 1.27);
      context.font = '800 12px Inter, sans-serif';
      context.fillText(axis.label, label.x, label.y);
    });
  }
  function buildVsInsights(players, forecast) {
    const lowerIndex = forecast.left <= forecast.right ? 0 : 1;
    const challenger = players[lowerIndex];
    const favorite = players[1 - lowerIndex];
    const challengerName = vsDisplayName(challenger);
    const challengerPentagon = challenger.stats?.statPentagon;
    const favoritePentagon = favorite.stats?.statPentagon;
    const paths = [];
    if (validVsPentagon(challengerPentagon) && validVsPentagon(favoritePentagon)) {
      const advantages = VS_COMBAT_AXES
        .map(axis => ({ axis, diff: Math.round(Number(challengerPentagon[axis.key]) - Number(favoritePentagon[axis.key])) }))
        .sort((a, b) => b.diff - a.diff);
      advantages.filter(item => item.diff > 0).slice(0, 2)
        .forEach(item => paths.push(`${item.axis.label}に強み`));
      if (!paths.length && advantages[0]) paths.push(`${advantages[0].axis.label}が最も食らいつける領域`);
    }
    const favoriteComponentMap = Object.fromEntries(vsComponents(favoritePentagon).map(item => [item.key, item.value]));
    vsComponents(challengerPentagon)
      .filter(item => !VS_UNCERTAIN_COMPONENTS.has(item.key))
      .map(item => ({ ...item, diff: item.value - Number(favoriteComponentMap[item.key]) }))
      .filter(item => Number.isFinite(item.diff) && item.diff >= 3)
      .sort((a, b) => b.diff - a.diff)
      .slice(0, 1)
      .forEach(item => paths.unshift(`隠れた強み：${item.label}`));
    const challengerGames = Number(challenger.stats?.mainCharGames || 0);
    const favoriteGames = Number(favorite.stats?.mainCharGames || 0);
    if (challengerGames > favoriteGames && favoriteGames > 0) paths.push('実戦経験の蓄積で上回る');
    const challengerProfile = vsPentagonBattleProfile(challengerPentagon);
    const favoriteProfile = vsPentagonBattleProfile(favoritePentagon);
    const challengerPerfectLabels = vsPerfectCombatLabels(challengerProfile);
    if (challengerGames > 10000) paths.push('非常に豊富なメインキャラ経験');
    if (challengerProfile?.nearPerfect) paths.unshift('全戦闘指標が極めて高い対応力');
    else if (challengerProfile?.elite) paths.unshift('全戦闘指標が高水準の総合力');
    if (challengerPerfectLabels.length) {
      paths.unshift(`${challengerPerfectLabels.join('・')}が最高水準`);
    } else if (challengerProfile?.attackAllIn) {
      paths.unshift('攻撃全振りの勢いで先に流れを握る');
    }
    if (challengerProfile?.clutchSpirit) paths.push('接戦と逆境の両方で勝負を残す粘り');
    else if (challengerProfile?.lateFocus) paths.push('苦しい状況でも終盤まで勝負を手放さない集中力');
    if (challengerProfile?.preciseEvasion) paths.push('相手の技をスカさせ、自分の技を的確に当てる');
    if (challengerProfile?.defenseLed) paths.push('守備からの切り返しで流れを奪う');
    if (favoriteProfile?.sustainedOffense && challengerProfile?.steadyDefense) {
      paths.push('相手の有効打と押し切りを受け止め、攻めが途切れた場面を狙う');
    }
    if (favoriteProfile?.attackAllIn) paths.push('相手の攻撃全振りを受け切った後が好機');
    else if (favoriteProfile?.attackHeavy) paths.push('相手の攻撃偏重を受け切った後が好機');
    if (favoriteProfile?.lowOffenseFlow) paths.push('相手が攻めを有効打や継続へ結び付けにくい場面から主導権を取る');
    if (favoriteProfile?.lowThrowEscape) paths.push('投げを選択肢に混ぜて守りを揺さぶる');
    if (favoriteProfile?.lowStageUse) paths.push('壁・床ギミックの活用差でリターンを伸ばす');
    if (favoriteProfile?.lowCloseBattles && favoriteProfile?.lowFightingSpirit) {
      paths.push('接戦まで持ち込み、相手が立て直す前に競った終盤を押し切る');
    } else if (favoriteProfile?.lowCloseBattles) {
      paths.push('接戦まで持ち込み、競った終盤の勝ち切りで差を作る');
    } else if (favoriteProfile?.lowFightingSpirit) {
      paths.push('相手が守勢に回った場面で攻めを切らさず、立て直す前に押し切る');
    }
    if (!paths.length) paths.push('一試合の読み合いなら番狂わせは十分あり');
    const facts = [];
    players.forEach(player => {
      const qualifiedRatings = player.stats?.qualifiedCharRatingMap || {};
      const allRatings = player.stats?.charRatingMap || {};
      const ratingMap = Object.keys(qualifiedRatings).length ? qualifiedRatings : allRatings;
      const eliteCharacterCount = Object.values(ratingMap)
        .filter(value => Number(value) >= 2000).length;
      if (eliteCharacterCount >= 2) {
        facts.push(`${vsDisplayName(player)}：複数キャラでμ2000以上／総合理解度に強み`);
      }
    });
    if (forecast.usable) facts.push(`レート差 ${Math.abs(forecast.ratings[0] - forecast.ratings[1]).toLocaleString()}`);
    if (forecast.winRateUsable) {
      facts.push(`メインキャラ勝率 ${forecast.winRates[0].toFixed(1)}% / ${forecast.winRates[1].toFixed(1)}%`);
      if (Math.abs(forecast.winRateAdjustment) >= .1) {
        const favoredName = forecast.winRateAdjustment > 0 ? vsDisplayName(players[0]) : vsDisplayName(players[1]);
        facts.push(`勝率補正 ${favoredName} +${Math.abs(forecast.winRateAdjustment).toFixed(1)}pt`);
      }
    }
    if (challengerGames || favoriteGames) {
      facts.push(`試合数 ${Number(players[0].stats?.mainCharGames || 0).toLocaleString()} / ${Number(players[1].stats?.mainCharGames || 0).toLocaleString()}`);
    }
    if (Math.abs(forecast.pentagonAdjustment || 0) >= .1) {
      const favoredName = forecast.pentagonAdjustment > 0 ? vsDisplayName(players[0]) : vsDisplayName(players[1]);
      facts.push(`戦闘傾向補正 ${favoredName} +${Math.abs(forecast.pentagonAdjustment).toFixed(1)}pt`);
    }
    [
      { player: players[0], profile: vsPentagonBattleProfile(players[0].stats?.statPentagon) },
      { player: players[1], profile: vsPentagonBattleProfile(players[1].stats?.statPentagon) }
    ].forEach(({ player, profile }) => {
      if (!profile) return;
      const notes = [];
      const perfectLabels = vsPerfectCombatLabels(profile);
      if (profile.nearPerfect) notes.push('超万能型');
      else if (profile.elite) notes.push('万能型');
      else if (!perfectLabels.length) {
        if (profile.attackAllIn) notes.push('攻撃全振り');
        else if (profile.attackHeavy) notes.push('攻撃偏重');
        else if (profile.defenseLed) notes.push('やや防御型');
      }
      if (perfectLabels.length) notes.push(`${perfectLabels.join('・')}完成域`);
      if (profile.perfectAppeal) notes.push('魅力最高水準');
      notes.push(...vsProfileFocusSummary(profile));
      if (profile.clutchSpirit) notes.push('接戦・逆境に強み');
      else if (profile.lateFocus) notes.push('闘志・集中力に強み');
      if (profile.preciseEvasion) notes.push('回避・精度に強み');
      if (notes.length) facts.push(`${vsDisplayName(player)}：${notes.join('／')}`);
    });
    const leftSeen = Number(players[0].stats?.lastSeenTimestamp || 0);
    const rightSeen = Number(players[1].stats?.lastSeenTimestamp || 0);
    if (leftSeen || rightSeen) facts.push(`データ鮮度 ${leftSeen >= rightSeen ? vsDisplayName(players[0]) : vsDisplayName(players[1])}が新しい`);
    return { lowerIndex, challengerName, favoriteName: vsDisplayName(favorite), paths: paths.slice(0, 3), facts };
  }
  function vsChallengerSupport(forecast, lowerIndex) {
    if (!forecast.usable) {
      return 'レートが揃っていないため予測は参考表示です。ペンタゴンの強みと実際の対戦内容を重視してください。';
    }
    const chance = lowerIndex === 0 ? forecast.left : forecast.right;
    if (chance < 10) {
      return `厳しい数字ですが、これは現在のμと戦績から見たスナップショットです。μは固定能力値ではなく一戦ごとに動き、連勝や復調でも差は縮まります。一本勝負ではキャラ相性、得意展開、読み合いが大きく動くため、${chance}%は「勝ち目なし」を意味しません。`;
    }
    if (chance < 20) {
      return `相手優勢の予測ですが、μは一戦ごとに変化する現在値で、毎回同じ結果になる数字ではありません。得意な展開へ持ち込み、上に挙げた強みを通せれば番狂わせは十分起こり得ます。`;
    }
    if (chance < 35) {
      const oneIn = Math.max(2, Math.round(100 / chance));
      return `長期予測では相手優勢ですが、目安では約${oneIn}戦に1回の期待値があります。読み合いと相性で覆せる、現実的な勝ち筋です。`;
    }
    return '数字が低くても勝ち目なしではありません。ほぼ互角に近く、読み合いと相性で十分に覆る範囲です。';
  }
  function vsFavoriteSupport(forecast, lowerIndex) {
    if (!forecast.usable) {
      return 'レートが揃っていないため、優勢とは断定できません。ペンタゴンと実際の対戦内容を重視してください。';
    }
    const chance = lowerIndex === 0 ? forecast.right : forecast.left;
    if (chance >= 90) {
      return `${chance}%は現在のμと戦績が示す圧倒的優勢です。ただし勝利確定ではありません。μは一戦ごとに動く現在値であり、一本勝負では相性や読み合いによる取りこぼしも起こります。`;
    }
    if (chance >= 80) {
      return `長期的には明確な優勢です。普段どおりの強みを通せれば勝利に近い一方、${chance}%は全勝を意味しません。現在のμに慢心せず、相手の得意展開を避けたい一戦です。`;
    }
    if (chance >= 65) {
      return `数字上は優勢ですが、安全圏ではありません。レート差を安定感として活かしつつ、相手のペンタゴン上の強みには警戒が必要です。`;
    }
    return 'わずかに優勢という程度で、実質的には接戦圏です。数字で受けに回らず、得意な展開を先に作れるかが勝負を分けます。';
  }
  function setVsCharacterPortrait(host, player) {
    const character = String(player.stats?.mainChar || '').trim();
    const fallback = host.querySelector('span');
    const image = host.querySelector('img');
    fallback.textContent = character ? character.slice(0, 1).toUpperCase() : '?';
    image.alt = character ? `${character} icon` : 'Character icon';
    const slug = character.normalize('NFKD').toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]+/g, '');
    const circularSource = slug
      ? `https://tight-bar-55c1.uracil123.workers.dev/?imageUrl=${encodeURIComponent(`https://ewgf.gg/static/circular_character_icons/${slug}.webp`)}`
      : '';
    const sources = [circularSource, player.stats?.mainCharImage].filter(Boolean);
    let sourceIndex = 0;
    const loadNext = () => {
      if (sourceIndex >= sources.length) {
        image.remove();
        return;
      }
      image.src = sources[sourceIndex++];
    };
    image.addEventListener('load', () => image.classList.add('is-loaded'), { once:true });
    image.addEventListener('error', loadNext);
    loadNext();
  }
  function createVsForecastPanel(players) {
    const forecast = calculateVsForecast(players);
    const insights = buildVsInsights(players, forecast);
    const panel = document.createElement('section');
    panel.className = 'vs-forecast-panel';
    panel.setAttribute('aria-label', '拳トモ対戦予報');
    const leftStyle = topVsAxis(players[0].stats?.statPentagon);
    const rightStyle = topVsAxis(players[1].stats?.statPentagon);
    const pentagonRead = buildVsPentagonRead(players);
    panel.innerHTML = `
      <div class="vs-forecast-eyebrow">BATTLE FORECAST <span>拳トモ予報</span></div>
      <div class="vs-forecast-names">
        <div class="vs-forecast-player is-left">
          <span class="vs-character-portrait"><span aria-hidden="true">?</span><img alt=""></span>
          <strong class="vs-side-left"></strong>
        </div>
        <div class="vs-forecast-player is-right">
          <span class="vs-character-portrait"><span aria-hidden="true">?</span><img alt=""></span>
          <strong class="vs-side-right"></strong>
        </div>
      </div>
      <div class="vs-forecast-scores"><b class="vs-score-left">${forecast.left}%</b><span>WIN EXPECTANCY</span><b class="vs-score-right">${forecast.right}%</b></div>
      <div class="vs-forecast-gauge" role="img" aria-label="勝利期待値 ${forecast.left}対${forecast.right}">
        <span class="vs-gauge-left"></span><i>VS</i><span class="vs-gauge-right"></span>
      </div>
      <div class="vs-forecast-verdict"><strong></strong><span>予測信頼度：${forecast.confidence}</span><small></small></div>
      <div class="vs-forecast-grid">
        <div class="vs-style-collision">
          <div class="vs-panel-title"><span>STYLE COLLISION</span><strong>重ね合わせペンタゴン</strong></div>
          <canvas class="vs-overlay-pentagon" aria-label="2人のプレイスタイル比較"></canvas>
          <div class="vs-style-legend"><span class="is-left"></span><span class="is-right"></span></div>
          <p class="vs-style-summary"></p>
          <div class="vs-pentagon-read"><strong>ペンタゴンの読み解き</strong><ul></ul><small>正式名称から直接読み取れる意味と複数のコミュニティ検証を優先した推定です。魅力は戦闘力と別カテゴリとして扱い、勝率補正には使用していません。</small></div>
        </div>
        <div class="vs-forecast-insights">
          <div class="vs-challenger-path">
            <div class="vs-panel-title"><span>CHALLENGER'S PATH</span><strong></strong></div>
            <ul></ul>
            <p></p>
          </div>
          <div class="vs-favorite-view">
            <div class="vs-panel-title"><span>FAVORITE'S EDGE</span><strong></strong></div>
            <p></p>
          </div>
          <div class="vs-battle-facts">
            <div class="vs-panel-title"><span>BATTLE FACTS</span><strong>比較ポイント</strong></div>
            <ul></ul>
          </div>
        </div>
      </div>`;
    panel.querySelector('.vs-side-left').textContent = vsDisplayName(players[0]);
    panel.querySelector('.vs-side-right').textContent = vsDisplayName(players[1]);
    setVsCharacterPortrait(panel.querySelector('.vs-forecast-player.is-left .vs-character-portrait'), players[0]);
    setVsCharacterPortrait(panel.querySelector('.vs-forecast-player.is-right .vs-character-portrait'), players[1]);
    panel.querySelector('.vs-forecast-verdict strong').textContent = forecast.verdict;
    panel.querySelector('.vs-forecast-verdict small').textContent = `${forecast.basisText || '利用可能な戦績による参考表示です。'} 実際の勝敗を保証するものではありません。`;
    panel.querySelector('.vs-challenger-path strong').textContent = `${insights.challengerName}の勝ち筋`;
    panel.querySelector('.vs-challenger-path p').textContent = vsChallengerSupport(forecast, insights.lowerIndex);
    panel.querySelector('.vs-favorite-view strong').textContent = `${insights.favoriteName}の優勢`;
    panel.querySelector('.vs-favorite-view p').textContent = vsFavoriteSupport(forecast, insights.lowerIndex);
    panel.querySelector('.vs-style-legend .is-left').textContent = `${vsDisplayName(players[0])}・${leftStyle?.style || '分析中'}`;
    panel.querySelector('.vs-style-legend .is-right').textContent = `${vsDisplayName(players[1])}・${rightStyle?.style || '分析中'}`;
    panel.querySelector('.vs-style-summary').textContent = leftStyle && rightStyle
      ? `${vsDisplayName(players[0])}の「${leftStyle.label}」と、${vsDisplayName(players[1])}の「${rightStyle.label}」がぶつかる一戦。`
      : 'ペンタゴンが揃うと、2人のプレイスタイルを重ねて表示します。';
    const pentagonReadList = panel.querySelector('.vs-pentagon-read ul');
    pentagonRead.lines.forEach(text => {
      const item = document.createElement('li');
      item.textContent = text;
      pentagonReadList.appendChild(item);
    });
    panel.querySelector('.vs-pentagon-read small').hidden = !pentagonRead.available;
    const pathList = panel.querySelector('.vs-challenger-path ul');
    insights.paths.forEach(text => {
      const item = document.createElement('li');
      item.textContent = text;
      pathList.appendChild(item);
    });
    const factsList = panel.querySelector('.vs-battle-facts ul');
    insights.facts.forEach(text => {
      const item = document.createElement('li');
      item.textContent = text;
      factsList.appendChild(item);
    });
    panel.style.setProperty('--vs-left-share', `${forecast.left}%`);
    requestAnimationFrame(() => panel.classList.add('is-calculated'));
    requestAnimationFrame(() => drawVsPentagon(panel.querySelector('.vs-overlay-pentagon'), players));
    return panel;
  }

  function syncVsComparisonLayout(stage = byId('vsComparisonStage')) {
    if (!stage) return;
    const cardsHost = stage.querySelector('.vs-comparison-cards');
    const slots = [...stage.querySelectorAll('.vs-comparison-slot')];
    if (!cardsHost || slots.length !== 2) return;
    const mobile = window.matchMedia('(max-width: 700px)').matches
      || (window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 700);
    slots.forEach(slot => {
      const card = slot.querySelector('.vs-comparison-card');
      if (!card) return;
      if (!mobile) {
        card.style.removeProperty('--vs-mobile-scale');
        slot.style.removeProperty('--vs-slot-height');
        return;
      }
      const baseWidth = 300;
      const slotWidth = Math.max(1, slot.clientWidth);
      const scale = Math.min(1, (slotWidth / baseWidth) * .96);
      card.style.setProperty('--vs-mobile-scale', String(scale));
      slot.style.setProperty('--vs-slot-height', `${Math.ceil(card.offsetHeight * scale + 8)}px`);
    });
    const players = vsSelectedKeys.map(vsPlayerData);
    drawVsPentagon(stage.querySelector('.vs-overlay-pentagon'), players);
  }
  async function closeVsComparison({ reset = true, animate = true, fromHistory = false } = {}) {
    const stage = byId('vsComparisonStage');
    if (window.vsComparisonResizeObserver) window.vsComparisonResizeObserver.disconnect();
    if (stage) {
      if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await stage.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: 190, easing: 'ease-out', fill: 'forwards' }
        ).finished.catch(() => {});
      }
      stage.remove();
    }
    document.querySelectorAll('#posterGrid > .poster-card.vs-source-hidden').forEach(card => card.classList.remove('vs-source-hidden'));
    if (reset) {
      vsModeActive = false;
      vsSelectedKeys = [];
      vsSelectionSnapshots.clear();
      updateVsModeView();
      showToast('VSモードを終了しました');
      const button = byId('vsModeToggleBtn');
      if (button) button.focus();
    }
    if (!fromHistory && history.state?.kentomoOverlay === 'vsComparisonStage') history.back();
  }

  function openVsComparison() {
    if (byId('vsComparisonStage') || vsSelectedKeys.length !== 2) return;
    const sources = vsSelectedKeys.map(selectionId => {
      const snapshot = vsSelectionSnapshots.get(selectionId);
      if (!snapshot) return null;
      const visible = snapshot.listId === activeListId
        ? document.querySelector(`#posterGrid > .poster-card[data-member-key="${CSS.escape(snapshot.key)}"]`)
        : null;
      return visible || snapshot.card;
    });
    if (sources.some(source => !source)) return;
    const sourceRects = vsSelectedKeys.map((selectionId, index) => {
      const snapshot = vsSelectionSnapshots.get(selectionId);
      return snapshot?.listId === activeListId ? sources[index].getBoundingClientRect() : null;
    });
    const stage = document.createElement('div');
    stage.id = 'vsComparisonStage';
    stage.className = 'vs-comparison-stage';
    stage.classList.toggle('is-mobile-fit', isMobileGridDevice());
    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-modal', 'true');
    stage.setAttribute('aria-label', '選択した2人のプレイヤーカード比較');
    stage.innerHTML = '<div class="vs-comparison-heading"><strong>⚔ VS COMPARISON <span>β</span></strong><button type="button" class="vs-comparison-close" aria-label="VS比較を終了">×</button></div><div class="vs-comparison-scroll"><div class="vs-comparison-content"><div class="vs-comparison-cards"></div></div></div>';
    const players = vsSelectedKeys.map(vsPlayerData);
    stage.querySelector('.vs-comparison-content').prepend(createVsForecastPanel(players));
    const cardsHost = stage.querySelector('.vs-comparison-cards');
    const clones = sources.map((source, index) => {
      const clone = source.cloneNode(true);
      cleanVsClone(clone);
      clone.classList.remove('vs-dimmed', 'vs-source-hidden');
      clone.classList.add('vs-comparison-card', 'vs-selected');
      clone.dataset.memberKey = vsSelectionSnapshots.get(vsSelectedKeys[index])?.key || '';
      clone.style.setProperty('--rand-deg', '0deg');
      const marker = clone.querySelector('.vs-selection-marker');
      if (marker) { marker.hidden = false; marker.textContent = `VS ${index + 1}`; }
      const slot = document.createElement('div');
      slot.className = 'vs-comparison-slot';
      slot.appendChild(clone);
      cardsHost.appendChild(slot);
      const sourceCanvases = source.querySelectorAll('canvas');
      clone.querySelectorAll('canvas').forEach((canvas, canvasIndex) => {
        const sourceCanvas = sourceCanvases[canvasIndex];
        if (!sourceCanvas) return;
        try {
          canvas.width = sourceCanvas.width;
          canvas.height = sourceCanvas.height;
          canvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
        } catch (_) {}
      });
      return clone;
    });
    document.body.appendChild(stage);
    if (history.state?.kentomoOverlay !== 'vsComparisonStage') {
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'vsComparisonStage' }, '');
    }
    syncVsComparisonLayout(stage);
    if (typeof ResizeObserver === 'function') {
      window.vsComparisonResizeObserver = new ResizeObserver(() => requestAnimationFrame(() => syncVsComparisonLayout(stage)));
      window.vsComparisonResizeObserver.observe(cardsHost);
      clones.forEach(clone => window.vsComparisonResizeObserver.observe(clone));
    }
    sources.forEach((source, index) => {
      if (sourceRects[index]) source.classList.add('vs-source-hidden');
    });
    stage.querySelector('.vs-comparison-close').onclick = () => closeVsComparison();
    stage.addEventListener('click', event => { if (event.target === stage) closeVsComparison(); });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clones.forEach((clone, index) => {
        const to = clone.getBoundingClientRect();
        const from = sourceRects[index];
        if (!from) {
          clone.animate(
            [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }],
            { duration: 260, easing: 'ease-out', fill: 'both' }
          );
          return;
        }
        clone.animate([
          { transform: `translate3d(${from.left - to.left}px,${from.top - to.top}px,0) scale(${from.width / Math.max(to.width, 1)})`, opacity: .25 },
          { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 }
        ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
      });
      stage.classList.add('is-visible');
      stage.querySelector('.vs-comparison-close').focus();
    }));
  }

  function toggleVsMode() {
    if (vsModeActive) {
      closeVsComparison();
      return;
    }
    vsModeActive = true;
    vsSelectedKeys = [];
    vsSelectionSnapshots.clear();
    updateVsModeView();
    showToast('1人目を選んだ後、マイリストを切り替えて2人目も選べます');
  }

  function selectVsCard(key) {
    if (!vsModeActive || !key || byId('vsComparisonStage')) return;
    const selectionId = `${activeListId || ''}::${key}`;
    const existingIndex = vsSelectedKeys.indexOf(selectionId);
    if (existingIndex >= 0) {
      vsSelectedKeys.splice(existingIndex, 1);
      vsSelectionSnapshots.delete(selectionId);
    } else {
      const member = window.currentMembersData?.[key];
      const sourceCard = document.querySelector(`#posterGrid > .poster-card[data-member-key="${CSS.escape(key)}"]`);
      if (!member || !sourceCard) return;
      const cardSnapshot = sourceCard.cloneNode(true);
      const sourceCanvases = sourceCard.querySelectorAll('canvas');
      cardSnapshot.querySelectorAll('canvas').forEach((canvas, index) => {
        const source = sourceCanvases[index];
        if (!source) return;
        try {
          canvas.width = source.width;
          canvas.height = source.height;
          canvas.getContext('2d').drawImage(source, 0, 0);
        } catch (_) {}
      });
      const snapshot = {
        id: selectionId,
        listId: activeListId,
        key,
        card: cardSnapshot,
        player: { key, member, stats: memberStats(member) }
      };
      if (vsSelectedKeys.length >= 2) {
        const removed = vsSelectedKeys.shift();
        vsSelectionSnapshots.delete(removed);
      }
      vsSelectedKeys.push(selectionId);
      vsSelectionSnapshots.set(selectionId, snapshot);
    }
    updateVsModeView();
    if (vsSelectedKeys.length === 2) {
      showToast('選択した2枚を中央へ移動します');
      setTimeout(openVsComparison, 120);
    }
  }

  function resetVsMode() {
    closeVsComparison({ reset: false, animate: false });
    vsModeActive = false;
    vsSelectedKeys = [];
    vsSelectionSnapshots.clear();
    updateVsModeView();
  }

  function beginCardReorder() {
    window.cardReorderInProgress = true;
    window.hasDeferredPosterRender = false;
    delete window.deferredPosterRenderData;
  }

  function endCardReorder() {
    window.cardReorderInProgress = false;
    if (!window.hasDeferredPosterRender) return;
    const latestData = window.deferredPosterRenderData;
    window.hasDeferredPosterRender = false;
    delete window.deferredPosterRenderData;
    renderPosters(latestData);
    setTimeout(addPerCardListActions, 0);
  }
  const byId = id => document.getElementById(id);
  function setCurrentUserAdmin(isAdmin) {
    window.isCurrentUserAdmin = Boolean(isAdmin);
    document.body.classList.toggle('kentomo-admin', Boolean(isAdmin));
    window.dispatchEvent(new CustomEvent('kentomo:admin-visibility', {
      detail: { isAdmin: Boolean(isAdmin) }
    }));
  }
  const safeName = value => String(value || '').trim().slice(0, 40);
  const applyActiveListName = name => {
    const safe = safeName(name) || 'マイリスト';
    if (byId('titleText')) {
      byId('titleText').textContent = safe;
      byId('titleText').style.visibility = 'visible';
    }
    document.title = `拳トモくん / ${safe}`;
    const select = byId('myListSelect');
    if (select && activeListId) {
      const option = [...select.options].find(item => item.value === activeListId);
      const count = currentListEntries.find(item => item.id === activeListId)?.memberCount;
      if (option) option.textContent = `${safe} · ${Number.isFinite(count) ? count : 0} players`;
    }
  };
  const applySharedListDocumentTitle = name => {
    const safe = safeName(name) || '共有リスト';
    document.title = `${safe}（閲覧専用）｜拳トモくん / BFF-kun`;
  };
  const gate = (title, text, mode = 'login') => {
    let root = byId('accessGate');
    if (!root) {
      root = document.createElement('div');
      root.id = 'accessGate';
      root.className = 'access-gate';
      document.body.appendChild(root);
    }
    root.hidden = false;
    const uid = activeUser ? activeUser.uid : '';
    const actionLabel = mode === 'login'
      ? 'Googleでログイン'
      : (mode === 'guest-error' ? 'もう一度試す' : 'ログアウト');
    const showAction = mode !== 'loading';
    root.innerHTML = `<section class="access-panel">
      <img class="access-vanilla" src="assets/icon-192.png" alt="バニラ">
      <h2>${title}</h2><p>${text}</p>
      ${mode === 'pending' ? `<p class="uid">${uid}</p><p><button class="access-action secondary" id="copyUid">UIDをコピー</button></p>` : ''}
      ${showAction ? `<button class="access-action" id="gateAction">${actionLabel}</button>` : ''}
      ${mode === 'login' ? '<button class="access-action secondary" id="adminGateAction">Googleで管理者ログイン</button>' : ''}
    </section>`;
    if (byId('gateAction')) {
      byId('gateAction').onclick = mode === 'login'
        ? signIn
        : (mode === 'guest-error' ? () => auth.signInAnonymously() : () => auth.signOut());
    }
    if (byId('adminGateAction')) byId('adminGateAction').onclick = () => window.openAdminLogin();
    if (byId('copyUid')) byId('copyUid').onclick = () => navigator.clipboard.writeText(uid).then(() => showToast('UIDをコピーしました'));
  };

  function hideGate() {
    const root = byId('accessGate');
    if (root) root.hidden = true;
    document.body.classList.remove('app-booting');
    byId('bootSplash')?.remove();
  }

  let portraitLockRetryTimer = 0;
  async function lockPortraitOrientation() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true;
    if (!standalone || !screen.orientation?.lock) return;
    try {
      await screen.orientation.lock('portrait');
      clearTimeout(portraitLockRetryTimer);
    } catch (_) {
      // Android may reject a lock while the installed PWA is still resuming.
      clearTimeout(portraitLockRetryTimer);
      portraitLockRetryTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') {
          screen.orientation.lock('portrait').catch(() => {});
        }
      }, 700);
    }
  }

  function installPortraitOrientationGuard() {
    if (document.documentElement.dataset.portraitGuardInstalled === 'true') return;
    document.documentElement.dataset.portraitGuardInstalled = 'true';
    const relock = () => lockPortraitOrientation();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') relock();
    }, { passive: true });
    window.addEventListener('pageshow', relock, { passive: true });
    screen.orientation?.addEventListener?.('change', relock);
    // A user gesture gives Android another opportunity when the startup lock
    // was rejected before the installed PWA became fully active.
    document.addEventListener('pointerdown', relock, { passive: true });
  }

  function installMobileLandscapeGuard() {
    const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);
    if (!mobileDevice || document.getElementById('mobileLandscapeGuard')) return;
    document.body.classList.add('kentomo-mobile-device');
    const guard = document.createElement('div');
    guard.id = 'mobileLandscapeGuard';
    guard.className = 'mobile-landscape-guard';
    guard.setAttribute('role', 'status');
    guard.setAttribute('aria-live', 'polite');
    guard.innerHTML = `
      <div class="mobile-landscape-guard-panel">
        <img src="assets/icon-192.png" alt="">
        <strong>縦向きでお楽しみください</strong>
        <span>端末を縦向きに戻すと、そのまま拳トモくんへ復帰します。</span>
      </div>`;
    document.body.appendChild(guard);
    const landscapeQuery = window.matchMedia('(orientation: landscape)');
    const sync = () => {
      document.body.classList.toggle('mobile-landscape-blocked', landscapeQuery.matches);
      guard.setAttribute('aria-hidden', landscapeQuery.matches ? 'false' : 'true');
    };
    landscapeQuery.addEventListener?.('change', sync);
    window.addEventListener('orientationchange', sync, { passive:true });
    sync();
  }

  async function signIn() {
    sessionStorage.removeItem('t8_admin_mode');
    if (!/^https?:$/.test(location.protocol)) {
      gate('HTTPで開いてください', 'Googleログインはファイルの直接表示では利用できません。同じフォルダーの start-user-lists-prototype.cmd から起動してください。', 'login');
      return;
    }
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (error) {
      if (error && error.code === 'auth/configuration-not-found') {
        gate('Firebase Authenticationの設定が必要です', 'Firebase Consoleで Authentication を開始し、ログイン方法の Google を有効化して保存してください。設定後、このページを再読み込みします。', 'login');
        return;
      }
      if (error && error.code === 'auth/unauthorized-domain') {
        gate('localhostの許可が必要です', 'Firebase Authentication の承認済みドメインへ localhost を追加してください。', 'login');
        return;
      }
      gate('ログインできませんでした', error.message, 'login');
    }
  }

  // Tekken 8 rank order (Season 1 base + Season 2 destruction ranks).
  // References: https://tekken.fandom.com/wiki/Tekken_8/Ranking_List
  // Official S2 names: https://en.bandainamcoent.eu/tekken/news/tekken-8-patch-20
  const MEMBER_SORT_RANKS = ['Beginner','1st Dan','2nd Dan','Fighter','Strategist','Combatant','Brawler','Ranger','Cavalry','Warrior','Assailant','Dominator','Vanquisher','Destroyer','Eliminator','Garyu','Shinryu','Tenryu','Mighty Ruler','Flame Ruler','Battle Ruler','Fujin','Raijin','Kishin','Bushin','Tekken King','Tekken Emperor','Tekken God','Tekken God Supreme','God of Destruction','God of Destruction I','God of Destruction II','God of Destruction III','God of Destruction IV','God of Destruction V','God of Destruction VI','God of Destruction VII','God of Destruction Infinity'];
  const normalizedRankIndex = value => {
    const raw = String(value || '').trim();
    const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'tekkenlordsupreme') return 28;
    if (normalized === 'tekkenlord') return 27;
    const destructionMatch = normalized.match(/(?:god|lord)ofdestruction(?:(infinity|ouroboros)|([1-7])|(vii|vi|iv|v|iii|ii|i))?$/);
    if (destructionMatch) {
      if (raw.includes('∞') || destructionMatch[1]) return 37;
      const suffix = destructionMatch[2] || destructionMatch[3] || '';
      const destructionLevel = { '': 0, '1': 1, i: 1, '2': 2, ii: 2, '3': 3, iii: 3, '4': 4, iv: 4, '5': 5, v: 5, '6': 6, vi: 6, '7': 7, vii: 7 }[suffix];
      return destructionLevel === undefined ? -1 : 29 + destructionLevel;
    }
    return MEMBER_SORT_RANKS.slice(0, 29).findIndex(rank => rank.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
  };
  function memberStats(member) {
    const id = typeof cleanTekkenId === 'function' ? cleanTekkenId(member && member.gameId) : String(member && member.gameId || '');
    if (typeof getLocalStats === 'function') return getLocalStats(id, member) || member.fetchedStats || {};
    return member.fetchedStats || {};
  }
  const playerNameSortGroup = value => {
    const first = String(value || '').normalize('NFKC').trim().charAt(0);
    if (!first) return 5;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return 0;
    if (/\p{Script=Latin}/u.test(first)) return 1;
    if (/\p{Number}/u.test(first)) return 2;
    if (/\p{Script=Han}/u.test(first)) return 3;
    return 4;
  };
  window.sortMemberEntries = entries => {
    window.memberSkillRanks = {};
    window.memberSkillRankValues = {};
    if (currentMemberSortMode === 'manual') return entries;
    const direction = currentMemberSortDirection === 'asc' ? 1 : -1;
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    const metric = member => {
      const stats = memberStats(member || {});
      const isHistorical = typeof window.isDormantStats === 'function'
        ? window.isDormantStats(stats)
        : Boolean(stats.rankIsAllTimeHighest || stats.ratingIsHistorical);
      if (excludeHistoricalFromSkillSort && isHistorical && ['rank','games','total_games','rating','winrate','power','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'].includes(currentMemberSortMode)) return null;
      if (currentMemberSortMode === 'name') return String(member && member.name || '');
      if (currentMemberSortMode === 'rank') return normalizedRankIndex(stats.danRank);
      if (currentMemberSortMode === 'games') return stats.mainCharGames === null || stats.mainCharGames === undefined ? null : Number(stats.mainCharGames);
      if (currentMemberSortMode === 'total_games') return stats.totalRecordedGames === null || stats.totalRecordedGames === undefined ? null : Number(stats.totalRecordedGames);
      if (currentMemberSortMode === 'winrate') return stats.rankedWinRate === null || stats.rankedWinRate === undefined ? null : Number(stats.rankedWinRate);
      if (currentMemberSortMode === 'rating') return stats.ratingMu === null || stats.ratingMu === undefined ? null : Number(stats.ratingMu);
      if (currentMemberSortMode === 'power') return stats.tekkenPower === null || stats.tekkenPower === undefined ? null : Number(stats.tekkenPower);
      if (currentMemberSortMode === 'last_active') {
        const lastActive = Number(stats.lastSeenTimestamp);
        return Number.isFinite(lastActive) && lastActive > 0 ? lastActive : null;
      }
      const pentagonKey = currentMemberSortMode.startsWith('pentagon_') ? currentMemberSortMode.slice('pentagon_'.length) : '';
      if (pentagonKey) {
        const value = stats.statPentagon && stats.statPentagon[pentagonKey];
        return value === null || value === undefined ? null : Number(value);
      }
      return null;
    };
    const decorated = entries.map((entry, index) => ({ entry, index, value: metric(entry[1]) }));
    const isMissing = item => item.value === null || item.value === '' || (typeof item.value === 'number' && (!Number.isFinite(item.value) || item.value < 0));
    const skillModes = ['rank','games','total_games','rating','winrate','power','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'];
    if (skillModes.includes(currentMemberSortMode)) {
      decorated.filter(item => !isMissing(item)).sort((a, b) => Number(b.value) - Number(a.value) || a.index - b.index).slice(0, 3).forEach((item, index) => {
        window.memberSkillRanks[item.entry[0]] = index + 1;
        window.memberSkillRankValues[item.entry[0]] = item.value;
      });
    }
    return decorated.sort((a, b) => {
      const aMissing = isMissing(a);
      const bMissing = isMissing(b);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (currentMemberSortMode === 'name') {
        const groupDifference = playerNameSortGroup(a.value) - playerNameSortGroup(b.value);
        // Kanji and symbol-leading names remain at the end even when the
        // direction is reversed; the arrow only reverses names within a group.
        if (groupDifference) return groupDifference;
      }
      const compared = typeof a.value === 'string' ? collator.compare(a.value, b.value) : Number(a.value) - Number(b.value);
      return compared ? compared * direction : a.index - b.index;
    }).map(item => item.entry);
  };
  function formatSkillRankValue(mode, value, member) {
    if (value === null || value === undefined || value === '') return '-';
    const numeric = Number(value);
    if (mode === 'rank') return String(memberStats(member || {}).danRank || '-');
    if (mode === 'games') return Number.isFinite(numeric) ? numeric.toLocaleString() + ' games' : '-';
    if (mode === 'total_games') return Number.isFinite(numeric) ? numeric.toLocaleString() + '戦' : '-';
    if (mode === 'rating') return Number.isFinite(numeric) ? 'μ ' + numeric : '-';
    if (mode === 'winrate') return Number.isFinite(numeric) ? numeric.toFixed(1) + '%' : '-';
    if (mode === 'power') return Number.isFinite(numeric) ? numeric.toLocaleString() : '-';
    if (mode.startsWith('pentagon_')) return Number.isFinite(numeric) ? String(Math.round(numeric)) : '-';
    return String(value);
  }
  const memberSortStorageKey = () => activeUser && activeListId
    ? `t8_member_sort_${activeUser.uid}_${activeListId}`
    : '';
  function readLocalMemberSort() {
    try {
      const raw = localStorage.getItem(memberSortStorageKey());
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function writeLocalMemberSort(mode, direction) {
    try { localStorage.setItem(memberSortStorageKey(), JSON.stringify({ mode, direction, excludeHistorical: excludeHistoricalFromSkillSort })); } catch (_) {}
  }
  async function persistMemberSortSetting(mode, direction) {
    writeLocalMemberSort(mode, direction);
    if (!settingsRef) return;
    try {
      await settingsRef.child('memberSort').set({ mode, direction, excludeHistorical: excludeHistoricalFromSkillSort });
    } catch (error) {
      console.warn('Firebase memberSort sync unavailable; using list-local setting:', error);
    }
  }

  function updateCardReorderHandles() {
    const isManual = currentMemberSortMode === 'manual';
    document.querySelectorAll('.card-reorder-handle').forEach(handle => {
      handle.hidden = !isManual;
      handle.disabled = !isManual;
      handle.setAttribute('aria-hidden', String(!isManual));
      handle.tabIndex = isManual ? 0 : -1;
    });
  }

  const MEMBER_SORT_SHORT_LABELS = {
    manual: '手動', name: 'プレイヤー名', rank: '段位', games: '試合数', total_games: '生涯全戦',
    rating: 'レート', winrate: '勝率', power: '鉄拳力', last_active: '最終対戦',
    pentagon_attack: '攻撃', pentagon_technique: '技術', pentagon_appeal: '魅力',
    pentagon_spirit: '精神', pentagon_defense: '防御'
  };

  function updateMemberSortControls() {
    const mode = byId('memberSortMode');
    const direction = byId('memberSortDirection');
    const excludeHistorical = byId('memberSortExcludeHistorical');
    if (mode) mode.value = currentMemberSortMode;
    const summaryLabel = byId('memberSortSummaryLabel');
    if (summaryLabel) summaryLabel.textContent = MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '手動';
    const listSummary = byId('listActionsSummary');
    if (listSummary) listSummary.setAttribute('aria-label', 'リスト設定メニュー。現在の並べ替え：' + (MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '手動'));
    if (excludeHistorical) excludeHistorical.checked = excludeHistoricalFromSkillSort;
    if (direction) {
      direction.disabled = currentMemberSortMode === 'manual';
      direction.textContent = currentMemberSortDirection === 'asc' ? '昇順 ↑' : '降順 ↓';
    }
    updateCardReorderHandles();
  }
  async function saveMemberSort(mode, direction = currentMemberSortDirection) {
    currentMemberSortMode = mode || 'manual';
    currentMemberSortDirection = direction === 'asc' ? 'asc' : 'desc';
    window.memberAutoSortActive = currentMemberSortMode !== 'manual';
    updateMemberSortControls();
    if (window.currentMembersData) { renderPosters(window.currentMembersData); setTimeout(addPerCardListActions, 0); }
    await persistMemberSortSetting(currentMemberSortMode, currentMemberSortDirection);
  }
  function disableAutoSortForManualReorder() {
    if (currentMemberSortMode === 'manual') return;
    currentMemberSortMode = 'manual';
    window.memberAutoSortActive = false;
    updateMemberSortControls();
    persistMemberSortSetting('manual', currentMemberSortDirection);
    showToast('ドラッグ操作のため手動順へ切り替えました');
  }

  const GRID_COLUMNS_AUTO = 'auto';
  const GRID_DESKTOP_FOUR_COLUMN_MIGRATION = 't8_grid_desktop_default_20260729_4';
  const CARD_LAYOUT_PORTRAIT = 'portrait';
  const CARD_LAYOUT_LANDSCAPE = 'landscape';
  const isMobileGridDevice = () => window.matchMedia('(max-width: 700px)').matches
    || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);
  const mobileGridColumnLimit = () => 2;
  const gridStorageKey = () => isMobileGridDevice()
    ? 't8_grid_columns_mobile'
    : 't8_grid_columns_desktop';
  const portraitGridMemoryKey = () => `${gridStorageKey()}_portrait_preference`;
  const layoutGridStorageKey = layout => `${gridStorageKey()}_${layout === CARD_LAYOUT_LANDSCAPE ? 'landscape' : 'portrait'}`;
  const defaultGridColumns = () => isMobileGridDevice() ? '2' : '4';
  const cardLayoutStorageKey = () => isMobileGridDevice()
    ? 't8_card_layout_mobile'
    : 't8_card_layout_desktop';
  const currentCardLayout = () => byId('posterGrid')?.dataset.cardLayout || CARD_LAYOUT_PORTRAIT;
  const isLandscapeCardLayout = () => currentCardLayout() === CARD_LAYOUT_LANDSCAPE;
  function applyCardLayout(value) {
    const grid = byId('posterGrid');
    if (!grid) return;
    const layout = value === CARD_LAYOUT_LANDSCAPE ? CARD_LAYOUT_LANDSCAPE : CARD_LAYOUT_PORTRAIT;
    const previousLayout = currentCardLayout();
    if (previousLayout === CARD_LAYOUT_PORTRAIT && layout === CARD_LAYOUT_LANDSCAPE) {
      try {
        const visibleColumns = grid.dataset.effectiveColumns || localStorage.getItem(layoutGridStorageKey(CARD_LAYOUT_PORTRAIT)) || localStorage.getItem(gridStorageKey()) || defaultGridColumns();
        localStorage.setItem(portraitGridMemoryKey(), visibleColumns);
        localStorage.setItem(layoutGridStorageKey(CARD_LAYOUT_PORTRAIT), visibleColumns);
      } catch (_) {}
    }
    grid.dataset.cardLayout = layout;
    grid.classList.toggle('card-layout-landscape', layout === CARD_LAYOUT_LANDSCAPE);
    const select = byId('cardLayoutSelect');
    if (select) select.value = layout;
    let columns = defaultGridColumns();
    try {
      columns = localStorage.getItem(layoutGridStorageKey(layout))
        || (layout === CARD_LAYOUT_PORTRAIT ? localStorage.getItem(portraitGridMemoryKey()) : '')
        || localStorage.getItem(gridStorageKey()) || columns;
    } catch (_) {}
    applyGridColumns(columns);
  }
  function restoreCardLayout() {
    let layout = CARD_LAYOUT_PORTRAIT;
    try { layout = localStorage.getItem(cardLayoutStorageKey()) || layout; } catch (_) {}
    applyCardLayout(layout);
  }
  function saveCardLayout(value) {
    const layout = value === CARD_LAYOUT_LANDSCAPE ? CARD_LAYOUT_LANDSCAPE : CARD_LAYOUT_PORTRAIT;
    try { localStorage.setItem(cardLayoutStorageKey(), layout); } catch (_) {}
    applyCardLayout(layout);
  }
  function syncMobileCardScale() {
    const grid = byId('posterGrid');
    if (!grid) return;
    if (window.mobileCardResizeObserver) window.mobileCardResizeObserver.disconnect();
    const scale = Number(grid.style.getPropertyValue('--mobile-card-scale'));
    const active = Boolean(grid.dataset.mobileFitColumns) && Number.isFinite(scale) && scale > 0 && scale < 1;
    grid.querySelectorAll(':scope > .poster-card').forEach(card => {
      if (!active) {
        card.style.removeProperty('--mobile-card-height-offset');
        return;
      }
      const unscaledHeight = card.offsetHeight;
      card.style.setProperty('--mobile-card-height-offset', `${-Math.max(0, unscaledHeight * (1 - scale))}px`);
    });
    if (!active || typeof ResizeObserver !== 'function') return;
    window.mobileCardResizeObserver = new ResizeObserver(entries => {
      const currentScale = Number(grid.style.getPropertyValue('--mobile-card-scale'));
      if (!Number.isFinite(currentScale) || currentScale <= 0 || currentScale >= 1) return;
      entries.forEach(entry => {
        const card = entry.target;
        card.style.setProperty('--mobile-card-height-offset', `${-Math.max(0, card.offsetHeight * (1 - currentScale))}px`);
      });
    });
    grid.querySelectorAll(':scope > .poster-card').forEach(card => window.mobileCardResizeObserver.observe(card));
  }
  function applyGridColumns(value) {
    const grid = byId('posterGrid');
    if (!grid) return;
    const app = grid.closest('.app-container');
    const requested = /^[1-5]$/.test(String(value)) ? String(value) : defaultGridColumns();
    const mobileLayout = isMobileGridDevice();
    // A full card cannot remain readable in three or more tracks on a phone.
    // Older builds tried to scale five complete cards into the viewport, which
    // reduced text columns to a few pixels and split words character-by-character.
    const mobileLimit = isLandscapeCardLayout() ? 1 : mobileGridColumnLimit();
    const desktopLimit = isLandscapeCardLayout() ? 2 : 5;
    const maxColumns = mobileLayout ? mobileLimit : desktopLimit;
    const normalized = Number(requested) > maxColumns ? String(maxColumns) : requested;
    grid.style.zoom = '';
    grid.style.width = '';
    grid.style.marginInline = '';
    grid.style.removeProperty('--mobile-card-scale');
    grid.style.removeProperty('--mobile-card-base-width');
    grid.dataset.mobileFitColumns = '';
    if (app) app.classList.remove('mobile-grid-fit');
    if (normalized === GRID_COLUMNS_AUTO) {
      grid.style.gridTemplateColumns = '';
      grid.style.justifyContent = '';
      if (app) { app.style.width = ''; app.style.maxWidth = ''; }
    } else {
      const columns = Number(normalized);
      if (mobileLayout) {
        const gap = 8;
        if (app) { app.style.width = ''; app.style.maxWidth = ''; }
        const board = grid.parentElement;
        const boardStyle = board ? getComputedStyle(board) : null;
        const boardContentWidth = board
          ? board.clientWidth - parseFloat(boardStyle.paddingLeft || 0) - parseFloat(boardStyle.paddingRight || 0)
          : document.documentElement.clientWidth - 28;
        const availableWidth = Math.max(1, Math.floor(boardContentWidth));
        const rawTrackWidth = Math.max(1, (availableWidth - Math.max(0, columns - 1) * gap) / columns);
        const maxTrackWidth = columns === 1 ? 560 : (columns === 2 ? 400 : 300);
        const trackWidth = Math.min(maxTrackWidth, rawTrackWidth);
        const cardWidth = trackWidth;
        const cardScale = 1;
        grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${trackWidth}px))`;
        grid.style.justifyContent = 'center';
        grid.style.width = '100%';
        grid.style.marginInline = '0';
        grid.style.setProperty('--mobile-card-scale', String(cardScale));
        grid.style.setProperty('--mobile-card-base-width', `${cardWidth}px`);
        grid.dataset.mobileFitColumns = normalized;
        if (app) app.classList.add('mobile-grid-fit');
      } else {
        // 横型を1列で読む場合は、一覧行を十分に横長にして情報の見通しを確保する。
        const cardWidth = isLandscapeCardLayout() ? (columns === 1 ? 680 : 520) : 300;
        const gap = isLandscapeCardLayout() ? 20 : 28;
        const boardChrome = 84;
        const naturalWidth = columns * cardWidth + Math.max(0, columns - 1) * gap + boardChrome;
        const viewportFloor = Math.min(1080, Math.max(280, window.innerWidth - 40));
        grid.style.gridTemplateColumns = `repeat(${columns}, ${cardWidth}px)`;
        grid.style.justifyContent = 'center';
        if (app) {
          app.style.width = `${Math.max(naturalWidth, viewportFloor)}px`;
          app.style.maxWidth = 'none';
        }
      }
    }
    requestAnimationFrame(syncMobileCardScale);
    const select = byId('gridColumnSelect');
    if (select) {
      Array.from(select.options).forEach(option => {
        const optionColumns = Number(option.value);
        const unavailable = Number.isFinite(optionColumns) && optionColumns > maxColumns;
        option.disabled = unavailable;
        option.hidden = unavailable;
      });
      if (select.value !== normalized) select.value = normalized;
    }
    grid.dataset.effectiveColumns = normalized;
  }
  function restoreGridColumns() {
    let saved = defaultGridColumns();
    try {
      const storageKey = gridStorageKey();
      const stored = localStorage.getItem(storageKey);
      if (!isMobileGridDevice() && !localStorage.getItem(GRID_DESKTOP_FOUR_COLUMN_MIGRATION)) {
        saved = !stored || stored === '3' ? '4' : stored;
        localStorage.setItem(storageKey, saved);
        localStorage.setItem(GRID_DESKTOP_FOUR_COLUMN_MIGRATION, '1');
      } else {
        saved = stored || defaultGridColumns();
      }
      if (!/^[1-5]$/.test(String(saved))) {
        saved = defaultGridColumns();
        localStorage.setItem(gridStorageKey(), saved);
      }
      if (!isLandscapeCardLayout()) {
        const portraitPreference = localStorage.getItem(portraitGridMemoryKey());
        const portraitLayoutPreference = localStorage.getItem(layoutGridStorageKey(CARD_LAYOUT_PORTRAIT));
        if (/^[1-5]$/.test(String(portraitLayoutPreference || portraitPreference))) saved = portraitLayoutPreference || portraitPreference;
      }
    } catch (_) {}
    if (isMobileGridDevice() && Number(saved) > mobileGridColumnLimit()) {
      saved = String(mobileGridColumnLimit());
      try { localStorage.setItem(gridStorageKey(), saved); } catch (_) {}
    }
    applyGridColumns(saved);
  }
  function saveGridColumns(value) {
    const safeValue = isMobileGridDevice() && Number(value) > mobileGridColumnLimit()
      ? String(mobileGridColumnLimit())
      : value;
    try {
      localStorage.setItem(gridStorageKey(), safeValue);
      localStorage.setItem(layoutGridStorageKey(currentCardLayout()), safeValue);
      if (!isLandscapeCardLayout()) localStorage.setItem(portraitGridMemoryKey(), safeValue);
    } catch (_) {}
    applyGridColumns(safeValue);
  }

  function injectWorkspace() {
    if (byId('listWorkspace')) return;
    const bar = document.createElement('nav');
    bar.id = 'listWorkspace';
    bar.className = 'list-workspace';
    bar.setAttribute('aria-label', 'マイリスト管理');
    bar.innerHTML = `
      <div class="workspace-primary">
        <select id="myListSelect" aria-label="表示するマイリスト"></select>
        <button id="workspaceAddMemberBtn" class="workspace-primary-action" title="メンバーを追加">＋ <span>メンバー追加</span></button>
      </div>
      <details class="workspace-dropdown" id="listActionsMenu">
        <summary id="listActionsSummary" aria-label="リスト設定メニュー。現在の並べ替え：手動" title="リスト設定"><span class="workspace-menu-settings-icon" aria-hidden="true">⚙</span><span class="workspace-menu-title"><span class="workspace-menu-title-full">リスト設定</span><span class="workspace-menu-title-short">設定</span></span><span class="workspace-sort-separator">/</span><span id="memberSortSummaryLabel">手動</span></summary>
        <div class="workspace-menu" role="menu">
          <button id="newListBtn" role="menuitem">＋ 新しいリスト</button>
          <button id="renameListBtn" role="menuitem">リスト名を変更</button>
          <button id="reorderListsBtn" role="menuitem">↕ リストの並び替え</button>
          <button id="shareListBtn" role="menuitem">🔗 閲覧専用の共有リンクを作成</button>
          <button id="shareFileBtn" role="menuitem">現在のリストを書き出す（JSON）</button>
          <button id="importListBtn" role="menuitem">リストデータを読み込む</button>
          <button id="exportListBtn" role="menuitem">全リストをバックアップ</button>
          <span class="workspace-menu-label workspace-award-label">拳トモ・アワード</span>
          <label class="award-setting"><input type="checkbox" id="awardEnabledToggle"> このリストで月間アワードを有効にする</label>
          <small class="award-setting-note" id="awardEnabledNote">月初と月末にサーバーが自動で記録します。リストを開かなくても動作します。</small>
          <button id="showAwardsBtn" role="menuitem">🏆 直近のアワードを見る</button>
          <span class="workspace-menu-label">メンバー自動並べ替え</span>
          <div class="member-sort-setting">
            <select id="memberSortMode" aria-label="メンバーの並べ替え基準">
              <option value="manual">手動順</option><option value="name">プレイヤー名順</option>
              <option value="rank">メインキャラ段位順</option><option value="games">メインキャラ試合数順</option><option value="total_games">生涯・全マッチング順</option>
              <option value="rating">レート順</option><option value="winrate">メインキャラ勝率順</option><option value="power">鉄拳力順</option>
              <option value="last_active">最終アクティブ（対戦）が新しい順</option>
              <option value="pentagon_attack">ペンタゴン・攻撃順</option><option value="pentagon_technique">ペンタゴン・技術順</option>
              <option value="pentagon_appeal">ペンタゴン・魅力順</option><option value="pentagon_spirit">ペンタゴン・精神順</option><option value="pentagon_defense">ペンタゴン・防御順</option>
            </select>
            <button type="button" id="memberSortDirection">降順 ↓</button>
          </div>
          <label class="member-sort-option"><input type="checkbox" id="memberSortExcludeHistorical"> 休眠中と判定された選手を試合数・腕前・ペンタゴン順から除外</label>
          <span class="workspace-menu-label workspace-data-update-label">データ更新</span>
          <div class="workspace-refresh-control">
            <button id="workspaceRefreshBtn" title="EWGF・Wavuから全員の最新データを取得">
              <span aria-hidden="true">↻</span><span>全員のデータを今すぐ更新</span>
            </button>
            <small>通常は12時間ごとに自動更新されます。登録人数分の通信が発生します。</small>
          </div>
          <button id="deleteListBtn" class="menu-danger" role="menuitem">リストを削除</button>
        </div>
      </details>
      <input id="importListFile" type="file" accept="application/json" hidden>
      <dialog class="list-order-dialog share-link-dialog" id="shareLinkDialog" aria-labelledby="shareLinkTitle">
        <div class="list-order-panel">
          <div class="list-order-heading">
            <div>
              <strong id="shareLinkTitle">閲覧専用の共有リンク</strong>
              <small>元のマイリストを更新すると、同じURLの内容にも自動で反映されます</small>
            </div>
            <button type="button" id="closeShareLinkBtn" aria-label="閉じる">×</button>
          </div>
          <label class="share-link-field">
            <span>共有URL</span>
            <input id="shareLinkUrl" type="text" readonly>
          </label>
          <p class="share-link-note">共有先では直接編集できません。「マイリストに取り込む」を押すと、その人専用の編集可能なコピーになります。</p>
          <div class="list-order-footer">
            <button type="button" id="copyShareLinkBtn">URLをコピー</button>
            <button type="button" id="closeShareLinkFooterBtn" class="workspace-primary-action">完了</button>
          </div>
        </div>
      </dialog>
      <dialog class="list-order-dialog list-name-dialog" id="listNameDialog" aria-labelledby="listNameDialogTitle">
        <form class="list-order-panel" id="listNameForm" method="dialog">
          <div class="list-order-heading">
            <div>
              <strong id="listNameDialogTitle">新しいリスト</strong>
              <small id="listNameDialogDescription">作成するマイリストの名前を入力してください</small>
            </div>
            <button type="button" id="closeListNameBtn" aria-label="閉じる">×</button>
          </div>
          <label class="list-name-field">
            <span>リスト名</span>
            <input id="listNameInput" type="text" maxlength="50" autocomplete="off" required>
          </label>
          <div class="list-order-footer">
            <button type="button" id="cancelListNameBtn">キャンセル</button>
            <button type="submit" id="saveListNameBtn" class="workspace-primary-action">作成</button>
          </div>
        </form>
      </dialog>
      <dialog class="list-order-dialog shared-import-confirm-dialog" id="sharedImportConfirmDialog" aria-labelledby="sharedImportConfirmTitle">
        <div class="list-order-panel">
          <div class="list-order-heading">
            <div>
              <strong id="sharedImportConfirmTitle">共有リストを取り込む</strong>
              <small>取り込んだリストは自分で編集できる独立したコピーになります</small>
            </div>
            <button type="button" id="closeSharedImportConfirmBtn" aria-label="閉じる">×</button>
          </div>
          <p class="shared-import-confirm-message" id="sharedImportConfirmMessage"></p>
          <div class="list-order-footer">
            <button type="button" id="cancelSharedImportConfirmBtn">キャンセル</button>
            <button type="button" id="confirmSharedImportBtn" class="workspace-primary-action">自分のマイリストへ取り込む</button>
          </div>
        </div>
      </dialog>
      <dialog class="list-order-dialog" id="listOrderDialog">
        <div class="list-order-panel">
          <div class="list-order-heading">
            <div><strong>マイリストの並び替え</strong><small>PCはドラッグ、スマホは矢印で移動</small></div>
            <button type="button" id="closeListOrderBtn" aria-label="閉じる">×</button>
          </div>
          <ol class="list-order-items" id="listOrderItems"></ol>
          <div class="list-order-footer">
            <button type="button" id="cancelListOrderBtn">キャンセル</button>
            <button type="button" id="saveListOrderBtn" class="workspace-primary-action">並び順を保存</button>
          </div>
        </div>
      </dialog>
      <dialog class="list-order-dialog member-transfer-dialog" id="memberTransferDialog" aria-labelledby="memberTransferTitle">
        <div class="list-order-panel">
          <div class="list-order-heading">
            <div>
              <strong id="memberTransferTitle">別リストへ移動</strong>
              <small id="memberTransferDescription">移動先のマイリストを選択してください</small>
            </div>
            <button type="button" id="closeMemberTransferBtn" aria-label="閉じる">×</button>
          </div>
          <label class="member-transfer-field">
            <span>移動先のマイリスト</span>
            <select id="memberTransferDestination" aria-label="移動先のマイリスト"></select>
          </label>
          <div class="list-order-footer">
            <button type="button" id="cancelMemberTransferBtn">キャンセル</button>
            <button type="button" id="executeMemberTransferBtn" class="workspace-primary-action">このリストへ移動</button>
          </div>
        </div>
      </dialog>
      <dialog class="main-character-logic-dialog kentomo-help-dialog" id="kentomoHelpDialog" aria-labelledby="kentomoHelpTitle">
        <div class="main-character-logic-panel">
          <div class="main-character-logic-heading">
            <div><strong id="kentomoHelpTitle">拳トモくんの使い方</strong><small>鉄拳仲間をカードにして、近況・強み・相性を楽しく見比べるアプリです</small></div>
            <button type="button" id="closeKentomoHelpBtn" aria-label="閉じる">×</button>
          </div>
          <div class="kentomo-help-deck">
            <div class="kentomo-help-slides">
              <section class="kentomo-help-slide is-active" data-help-slide="0">
                <div class="help-slide-copy"><em>STEP 1</em><h3>まず、自分のリストを作る</h3><p>画面右上の<strong>「リスト設定」</strong>を押し、<strong>「＋ 新しいリスト」</strong>を選びます。友人、対戦会、注目選手など用途別に何個でも分けられます。</p></div>
                <div class="help-screen help-screen-list"><div class="help-browser-bar">拳トモくん　　<span>マイリスト：拳トモ</span><button>⚙ リスト設定 / 手動 ▾</button></div><div class="help-menu-shot"><b>リスト操作</b><span class="help-hotspot">＋ 新しいリスト</span><span>リスト名を変更</span><span>↕ リストの並び替え</span></div><div class="help-callout is-menu">ここをクリック！</div><div class="help-empty-shot">ここに拳トモのカードが並びます</div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="1" hidden>
                <div class="help-slide-copy"><em>STEP 2</em><h3>鉄拳仲間(拳トモ)を追加する</h3><p>上部の<strong>「＋ メンバー追加」</strong>を押し、<strong>鉄拳8 ID</strong>を入力して保存します。名前は未入力なら自動取得名を1段でメイン表示します。身内での呼び名などを入力すると、🔒付きの固定名を大きく表示し、最新の自動取得名を2段目に併記します。</p></div>
                <div class="help-screen help-screen-add"><div class="help-browser-bar">拳トモくん</div><button class="help-add-shot">＋ メンバー追加</button><div class="help-arrow">クリックすると<br>↓</div><div class="help-modal-shot"><b>メンバーを作成</b><label>カードに表示する名前（任意）<span>入力名＋自動取得名も可能</span></label><label>鉄拳8 ID（12桁ハイフン不要）<span>ここに12桁のIDを入力</span></label><button>メンバーを追加</button></div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="2" hidden>
                <div class="help-slide-copy"><em>STEP 3</em><h3>カードの気になる場所をタップ</h3><p>プレイヤー画像右上の<strong>Steam・PlayStation・Xboxアイコン</strong>から、その選手の外部プロフィールを開けます。<strong>RECENT MAINの枠</strong>からは、そのプレイヤー本人の対戦履歴に基づく相手キャラ別の得意・苦手傾向を確認できます。ペンタゴンからは<strong>そのプレイヤーのプレイ傾向の詳細</strong>を開けます。ID欄を押すと、<strong>TEKKEN 8 IDを文字列としてコピー</strong>できます。</p></div>
                <div class="help-screen help-screen-card"><div class="help-card-shot"><div class="help-card-face">PLAYER<img src="assets/platform/playstation.svg" alt="" aria-hidden="true"></div><b>サンプル選手</b><small>最終対戦　2時間前</small><div class="help-card-stats">RECENT MAIN　LIDIA<br>RANK　鉄拳王　μ 1784</div><div class="help-card-pentagon"><i></i><span>STAT<br>PENTAGON</span></div><code>TEKKEN 8 ID　（サンプル表示）</code></div><div class="help-pin pin-face">① RECENT MAIN → この選手の相手キャラ別傾向</div><div class="help-pin pin-penta">② ペンタゴン → この選手の詳細分析</div><div class="help-pin pin-id">③ ID → コピー</div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="3" hidden>
                <div class="help-slide-copy"><em>STEP 4</em><h3>2人をVSモードで比べる</h3><p><strong>「⚔ VSモード」</strong>を押してカードを2枚選択。1人目を選んだあとに上部のマイリストを切り替えれば、<strong>別々のマイリストにいる2人</strong>も比較できます。予測勝率、ペンタゴンの重ね合わせ、キャラ相性とそれぞれの勝ち筋を対戦画面風に表示します。</p></div>
                <div class="help-screen help-screen-vs"><button class="help-vs-button">⚔ VSモード</button><div class="help-vs-pick"><div class="help-mini-card is-picked">VS 1<br><b>PLAYER A</b></div><strong>＋</strong><div class="help-mini-card is-picked">VS 2<br><b>PLAYER B</b></div></div><div class="help-vs-result"><b>WIN PROJECTION</b><div><span>62%</span><i></i><span>38%</span></div><small>ペンタゴン・相性・勝ち筋をまとめて表示</small></div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="4" hidden>
                <div class="help-slide-copy"><em>STEP 5</em><h3>仲間とマイリストを共有する</h3><p><strong>「閲覧専用の共有リンクを作成」</strong>でURLを送れば、受け取った人はアクセスするだけでカードを見られ、元リストの変更も自動反映されます。URLを使わずファイルで渡したい場合は、<strong>「現在のリストを書き出す（JSON）」</strong>で保存し、受け取った人が<strong>「リストデータを読み込む」</strong>ことで編集可能なリストとして使えます。JSONは受け渡した時点の独立コピーなので、以後は元リストへ自動追従しません。</p></div>
                <div class="help-screen help-screen-tools"><div class="help-tools-top"><select><option>拳トモ</option></select><button>＋ メンバー追加</button><button class="is-open">⚙ リスト設定</button><button>❔ ヘルプ</button><button>◉ 表示・アカウント</button></div><div class="help-share-flow"><div><b>作った人</b><span>URLまたはJSONを<br>作成・送信</span></div><i>アクセス／読込<br>→</i><div><b>受け取った人</b><span>URLは閲覧・追従<br>JSONは編集コピー</span></div></div><div class="help-tools-menu"><b>実際のリスト設定</b><span class="is-share">閲覧専用の共有リンクを作成</span><span class="is-import">現在のリストを書き出す（JSON）</span><span class="is-import">リストデータを読み込む</span><small>JSONはその時点の独立コピー</small></div><div class="help-tool-label label-menu">URLでもファイルでも共有</div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="5" hidden>
                <div class="help-slide-copy"><em>STEP 6</em><h3>Googleログインでマイリストを同期</h3><p><strong>ゲストアカウントのままでも利用できます。</strong>Googleでログインすると、作成したマイリストがアカウントごとに記録され、スマホやパソコンなど<strong>別のデバイスでも同じマイリスト</strong>を開けます。</p></div>
                <div class="help-screen help-screen-login"><div class="help-login-account"><span>◉ 表示・アカウント</span><button>Googleでログイン</button></div><div class="help-login-flow"><div><b>ゲストでも利用OK</b><span>このデバイスで<br>すぐに使えます</span></div><i>Googleログイン<br>↓</i><div class="help-login-cloud"><b>マイリストを記録</b><span>Googleアカウントごとに<br>保存</span></div></div><div class="help-device-sync"><div><b>📱 スマホ</b><span>拳トモ</span></div><strong>同じ<br>マイリスト</strong><div><b>💻 パソコン</b><span>拳トモ</span></div></div><div class="help-tool-label label-login">端末が変わっても続きから</div></div>
              </section>
              <section class="kentomo-help-slide" data-help-slide="6" hidden>
                <div class="help-slide-copy"><em>STEP 7</em><h3>共有リストの更新・お気に入り・取り込み</h3><p>閲覧専用URLは、作成者が元のマイリストを編集すると<strong>同じURLのまま自動更新</strong>されます。<strong>「お気に入りに登録」</strong>するとコピーせずにマイリスト選択欄からいつでも開け、元リストへの追従も続きます。閲覧する人も<strong>「リスト設定」から表示順を変更</strong>でき、その並び方は自分の端末だけに保存されます。自分で編集したい場合だけ<strong>「このリストを取り込む」</strong>を押すと、その時点の独立コピーになります。</p></div>
                <div class="help-screen help-screen-tools"><div class="help-share-flow"><div><b>作成者の元リスト</b><span>追加・編集・削除<br>元の並び順</span></div><i>同じURLへ<br>自動反映 →</i><div><b>閲覧専用リスト</b><span>開いたままでも<br>内容を更新</span></div></div><div class="help-tools-menu"><b>閲覧する人の操作</b><span>★ お気に入り → 追従したまま再アクセス</span><span>⚙ 表示順を変更（この端末だけ）</span><span class="is-share">このリストを取り込む → 独立コピー</span><span class="is-import">自分のマイリストへ戻る</span></div><div class="help-tool-label label-menu">共有URLは常に最新</div></div>
              </section>
            </div>
            <div class="kentomo-help-nav"><button type="button" id="kentomoHelpPrev">‹ 前へ</button><div id="kentomoHelpDots" aria-label="ページ"><button class="is-active" aria-label="1ページ目"></button><button aria-label="2ページ目"></button><button aria-label="3ページ目"></button><button aria-label="4ページ目"></button><button aria-label="5ページ目"></button><button aria-label="6ページ目"></button><button aria-label="7ページ目"></button></div><span id="kentomoHelpPage">1 / 7</span><button type="button" id="kentomoHelpNext">次へ ›</button></div>
          </div>
          <div class="main-character-logic-footer"><button type="button" id="dismissKentomoHelpBtn" class="workspace-primary-action">ヘルプを閉じる</button></div>
        </div>
      </dialog>
      <dialog class="main-character-logic-dialog" id="mainCharacterLogicDialog" aria-labelledby="mainCharacterLogicTitle">
        <div class="main-character-logic-panel">
          <div class="main-character-logic-heading">
            <div><strong id="mainCharacterLogicTitle">メインキャラはどう決まる？</strong><small>強さを優先し、信頼できるデータがない場合はやり込み量で判定します</small></div>
            <button type="button" id="closeMainCharacterLogicBtn" aria-label="閉じる">×</button>
          </div>
          <section class="main-character-player-diagnostics" id="mainCharacterPlayerDiagnostics" hidden>
            <div class="dormant-diagnostic-player"><span>判定対象</span><strong id="mainCharacterDiagnosticPlayerName">-</strong><small id="mainCharacterDiagnosticPlayerId">-</small></div>
            <div class="main-character-ranking" id="mainCharacterRanking"></div>
            <div class="dormant-diagnostic-reason"><strong>この判定になった根拠</strong><p id="mainCharacterDiagnosticReason"></p></div>
          </section>
          <ol class="main-character-logic-steps">
            <li><span>1</span><div><strong>Wavuの信頼できる候補に絞る</strong><p>Leaderboardの <b>σ² &lt; 75</b> に入っているキャラを候補にします。σ²はレーティングの不確かさで、小さいほど判定材料が十分にある状態です。</p></div></li>
            <li><span>2</span><div><strong>μが最も高いキャラを選ぶ</strong><p>候補の中で、Wavuの推定レーティング <b>μ</b> が一番高いキャラをメインと判定します。別キャラの試合数が多くても、μの高さを優先します。</p></div></li>
            <li><span>3</span><div><strong>μが同じなら試合数で決める</strong><p>最高μが同率の場合だけ、Leaderboard内の試合数が多いキャラを優先します。</p></div></li>
            <li><span>4</span><div><strong>候補がいなければ生涯データへ</strong><p>σ² &lt; 75 の候補がいない場合は、EWGFで生涯試合数が最も多いキャラをメインと判定します。</p></div></li>
          </ol>
          <div class="main-character-logic-note"><strong>表示データと活動状況について</strong><p>メインキャラ決定後、そのキャラの段位・All-time Ranked試合数・勝率・画像をEWGFから取得します。Leaderboard資格外のμは「※」付きの過去参考値として表示しますが、それだけで休眠とは決めません。Wavuで確認できる最近のランクマッチ数は、メインキャラ選択ではなく活動状況の判定に使います。自動更新は12時間ごとで、必要なときは「全員のデータ更新」から手動更新できます。</p></div>
          <div class="main-character-logic-footer"><button type="button" id="dismissMainCharacterLogicBtn" class="workspace-primary-action">閉じる</button></div>
        </div>
      </dialog>
      <dialog class="main-character-logic-dialog" id="dormantPlayerLogicDialog" aria-labelledby="dormantPlayerLogicTitle">
        <div class="main-character-logic-panel">
          <div class="main-character-logic-heading">
            <div><strong id="dormantPlayerLogicTitle">休眠中プレイヤーはどう決まる？</strong><small>最近のランクマッチ実績を優先し、段位・レートの鮮度も合わせて判定します</small></div>
            <button type="button" id="closeDormantPlayerLogicBtn" aria-label="閉じる">×</button>
          </div>
          <section class="dormant-player-diagnostics" id="dormantPlayerDiagnostics" hidden>
            <div class="dormant-diagnostic-player"><span>判定対象</span><strong id="dormantDiagnosticPlayerName">-</strong><small id="dormantDiagnosticPlayerId">-</small></div>
            <div class="dormant-activity-grid">
              <article><span>直近7日のランクマ</span><strong id="dormantRecent7d">0試合</strong><small>現役基準：3試合以上</small></article>
              <article><span>直近30日のランクマ</span><strong id="dormantRecent30d">0試合</strong><small>現役基準：10試合以上</small></article>
              <article><span>最後のランクマ</span><strong id="dormantLatestRanked">確認できず</strong><small id="dormantRankedSample">取得標本 0件</small></article>
              <article><span>最後に確認できた対戦</span><strong id="dormantLatestBattle">確認できず</strong><small id="dormantLatestBattleType">対戦種別不明</small></article>
            </div>
            <div class="dormant-diagnostic-reason"><strong>このプレイヤーが休眠判定になった理由</strong><p id="dormantDiagnosticReason"></p></div>
          </section>
          <div class="dormant-player-explanation">
            <p>拳トモくんの「休眠中」は、Wavuで確認できる最近の<b>ランクマッチだけ</b>を活動実績として数えます。<b>直近7日で3試合以上</b>、または<b>直近30日で10試合以上</b>なら、過去μなどが表示されていても現役として扱います。プレイヤーマッチ・クイックバトル・グループマッチは、この試合数には含みません。</p>
            <p>最近のランクマッチ数が上の基準に届かなくても、現在有効な段位とWavuの信頼できるレートが確認できる選手は通常表示です。最近のランクマッチ実績が基準未満で、さらにメインキャラの現在段位がなく <b>All-time highest rank</b> だけが残っている場合や、Wavuの <b>σ² &lt; 75</b> を満たす現在レートがなく過去のμだけ参照できる場合に、データの鮮度を示すため休眠表示にします。</p>
            <p>休眠中のカードでは、過去記録であることが直感的に分かるよう、キャラ画像・段位・μ・勝率・試合数・鉄拳力を落ち着いた色にします。選手を低く評価する意味ではなく、データの鮮度を区別するための表示です。</p>
          </div>
          <div class="main-character-logic-note"><strong>並べ替えについて</strong><p>リスト設定の「休眠中と判定された選手を除外」を有効にすると、腕前・試合数・ペンタゴン系の自動順位だけから除外できます。カード自体がリストから消えることはありません。</p></div>
          <div class="main-character-logic-footer"><button type="button" id="dismissDormantPlayerLogicBtn" class="workspace-primary-action">閉じる</button></div>
        </div>
      </dialog>
      <dialog class="main-character-logic-dialog" id="cameraHelpDialog" aria-labelledby="cameraHelpTitle">
        <div class="main-character-logic-panel">
          <div class="main-character-logic-heading">
            <div><strong id="cameraHelpTitle">カメラボタンでできること</strong><small>拳トモカードを画像として保存・共有できます</small></div>
            <button type="button" id="closeCameraHelpBtn" aria-label="閉じる">×</button>
          </div>
          <div class="camera-help-content">
            <div class="camera-help-icon" aria-hidden="true">📷</div>
            <div><strong>プレイヤーカードをPNG画像にする</strong><p>各プレイヤーカード下部のカメラボタンを押すと、そのカードを1枚のPNG画像として保存できます。カードに表示されている名前、段位、レート、ペンタゴンなどを仲間へ共有したいときに使えます。</p></div>
            <div><strong>画面テーマも画像へ反映</strong><p>現在選んでいるカードデザインで書き出します。保存処理中は画像の生成が終わるまで、そのまま少しお待ちください。</p></div>
            <div><strong>外部ページは開きません</strong><p>カメラはスクリーンショット保存専用です。EWGFやWavuを開くボタンではなく、マイリストの内容を変更することもありません。</p></div>
          </div>
          <div class="main-character-logic-footer"><button type="button" id="dismissCameraHelpBtn" class="workspace-primary-action">閉じる</button></div>
        </div>
      </dialog>
      <details class="workspace-dropdown workspace-help" id="helpMenu">
        <summary title="ヘルプ"><span aria-hidden="true">❔</span><span>ヘルプ</span><span aria-hidden="true">▾</span></summary>
        <div class="workspace-menu" role="menu">
          <span class="workspace-menu-label workspace-help-label">ヘルプ・使い方</span>
          <button id="kentomoHelpBtn" class="workspace-help-command" role="menuitem"><span>❔</span><b>拳トモくんの使い方</b><small>画面を見ながら基本操作を確認</small></button>
          <button id="mainCharacterLogicBtn" class="workspace-help-command" role="menuitem"><span>★</span><b>メインキャラ判定について</b><small>どのデータから判定するか</small></button>
          <button id="dormantPlayerLogicBtn" class="workspace-help-command" role="menuitem"><span>◷</span><b>休眠中プレイヤー判定について</b><small>休眠表示になる条件を確認</small></button>
          <button id="cameraHelpBtn" class="workspace-help-command" role="menuitem"><span>📷</span><b>カメラボタンについて</b><small>カード画像の保存方法を確認</small></button>
        </div>
      </details>
      <details class="workspace-dropdown workspace-account" id="accountMenu">
        <summary title="表示・アカウント"><span aria-hidden="true">◉</span><span class="workspace-account-title">表示・アカウント</span><small class="user-chip" id="userChip"></small><span aria-hidden="true">▾</span></summary>
        <div class="workspace-menu" role="menu">
          <span class="workspace-menu-label">表示テーマ</span>
          <div class="theme-menu-row">
            <button type="button" data-theme-choice="wanted" title="WANTED">酒場</button>
            <button type="button" data-theme-choice="modern" title="MODERN">ネオン</button>
            <button type="button" data-theme-choice="japanese" title="JAPANESE">和風</button>
          </div>
          <span class="workspace-menu-label">カード列数</span>
          <div class="grid-column-setting">
            <select id="gridColumnSelect" aria-label="カードの表示列数">
              <option value="1">1列</option><option value="2">2列</option><option value="3">3列</option>
              <option value="4">4列</option><option value="5">5列</option>
            </select>
            <small>PCは幅を維持／スマホは画面内へ縮小</small>
          </div>
          <span class="workspace-menu-label">カードの向き</span>
          <div class="grid-column-setting">
            <select id="cardLayoutSelect" aria-label="プレイヤーカードの向き">
              <option value="portrait">縦型カード</option>
              <option value="landscape">横型カード</option>
            </select>
            <small>横型は情報を横に広げます（スマホでは1列表示）</small>
          </div>
          <button id="adminToolsToggleBtn" class="admin-tools-toggle" role="menuitem" hidden><span>🛠 管理者メニュー</span><span aria-hidden="true">›</span></button>
          <div id="adminToolsMenu" class="admin-tools-menu" hidden>
            <button id="adminPanelBtn" role="menuitem" hidden>完全自動取得・管理診断</button>
            <button id="adminCacheResetBtn" role="menuitem" hidden>このリストのキャッシュを完全更新</button>
            <button id="adminLocalCacheClearBtn" role="menuitem" hidden>この端末の統計キャッシュを全削除</button>
          </div>
          <div class="account-sync-note" id="accountSyncNote"></div>
          <button id="logoutBtn" role="menuitem">管理者ログイン</button>
        </div>
      </details>`;
    document.querySelector('.board-container').prepend(bar);
    document.body.classList.add('workspace-ui-active');
    byId('userChip').textContent = activeUser.isAnonymous
      ? 'ゲストユーザー'
      : (activeUser.displayName || activeUser.email || 'Google User');
    byId('accountSyncNote').innerHTML = activeUser.isAnonymous
      ? '<strong>Google連携で端末間共有</strong><span>Googleログイン時、メールアドレスは管理者へ通知されます。マイリストはアカウントごとに保持されるため、端末を切り替えても利用できます。</span>'
      : `<strong>Googleアカウント連携済み</strong><span>${String(activeUser.email || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}<br>同じGoogleアカウントで別端末からマイリストを開けます。</span>`;
    byId('logoutBtn').textContent = activeUser.isAnonymous ? 'Googleアカウントに連携' : 'ゲストモードへ切り替える';
    const closeWorkspaceMenus = () => {
      const openMenus = [...bar.querySelectorAll('.workspace-dropdown[open]')];
      if (!openMenus.length) return;
      window.workspaceMenuSuppressHistory = true;
      openMenus.forEach(menu => menu.removeAttribute('open'));
      queueMicrotask(() => { window.workspaceMenuSuppressHistory = false; });
      if (openMenus.some(menu => history.state?.kentomoOverlay === menu.id)) {
        window.workspaceMenuHistoryClosing = true;
        history.back();
      }
    };
    const positionWorkspaceMenu = details => {
      const menu = details && details.querySelector('.workspace-menu');
      if (!menu) return;
      if (!window.matchMedia('(max-width: 700px)').matches) {
        menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
        return;
      }
      const trigger = details.querySelector('summary');
      const rect = trigger.getBoundingClientRect();
      const top = Math.min(rect.bottom + 7, window.innerHeight - 56);
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.bottom = 'auto';
      menu.style.maxHeight = `${Math.max(48, window.innerHeight - Math.max(8, top) - 8)}px`;
    };
    const repositionOpenWorkspaceMenus = () => bar.querySelectorAll('.workspace-dropdown[open]').forEach(positionWorkspaceMenu);
    bar.querySelectorAll('.workspace-dropdown').forEach(details => details.addEventListener('toggle', () => {
      if (!details.open) {
        if (!window.workspaceMenuSuppressHistory && history.state?.kentomoOverlay === details.id) {
          window.workspaceMenuHistoryClosing = true;
          history.back();
        }
        return;
      }
      window.workspaceMenuSuppressHistory = true;
      bar.querySelectorAll('.workspace-dropdown[open]').forEach(other => {
        if (other !== details) other.removeAttribute('open');
      });
      queueMicrotask(() => { window.workspaceMenuSuppressHistory = false; });
      if (history.state?.kentomoOverlay !== details.id) {
        history.pushState({ ...(history.state || {}), kentomoOverlay: details.id }, '');
      }
      requestAnimationFrame(() => positionWorkspaceMenu(details));
    }));
    if (window.workspaceMenuPositionHandler) {
      window.removeEventListener('resize', window.workspaceMenuPositionHandler);
      window.removeEventListener('scroll', window.workspaceMenuPositionHandler);
    }
    window.workspaceMenuPositionHandler = repositionOpenWorkspaceMenus;
    window.addEventListener('resize', repositionOpenWorkspaceMenus, { passive: true });
    window.addEventListener('scroll', repositionOpenWorkspaceMenus, { passive: true });
    byId('myListSelect').onchange = event => {
      const value = String(event.target.value || '');
      if (value.startsWith('shared:')) {
        const shareId = validSharedListId(value.slice('shared:'.length));
        if (shareId) location.assign(sharedListUrl(shareId));
        return;
      }
      if (sharedListView) {
        localStorage.setItem(`active_list_${activeUser.uid}`, value);
        const url = new URL(location.href);
        url.searchParams.delete('list');
        location.assign(url.toString());
        return;
      }
      activateList(value);
    };
    byId('gridColumnSelect').onchange = event => saveGridColumns(event.target.value);
    byId('cardLayoutSelect').onchange = event => saveCardLayout(event.target.value);
    restoreCardLayout();
    restoreGridColumns();
    if (window.workspaceGridResizeHandler) window.removeEventListener('resize', window.workspaceGridResizeHandler);
    let gridResizeFrame = 0;
    window.workspaceGridResizeHandler = () => {
      cancelAnimationFrame(gridResizeFrame);
      gridResizeFrame = requestAnimationFrame(restoreGridColumns);
    };
    window.addEventListener('resize', window.workspaceGridResizeHandler, { passive: true });
    if (window.workspaceBoardResizeObserver) window.workspaceBoardResizeObserver.disconnect();
    const workspaceBoard = byId('posterGrid')?.parentElement;
    if (workspaceBoard && typeof ResizeObserver === 'function') {
      let lastBoardWidth = workspaceBoard.clientWidth;
      window.workspaceBoardResizeObserver = new ResizeObserver(entries => {
        const nextBoardWidth = entries[0]?.contentRect?.width || workspaceBoard.clientWidth;
        if (Math.abs(nextBoardWidth - lastBoardWidth) < 1) return;
        lastBoardWidth = nextBoardWidth;
        window.workspaceGridResizeHandler();
      });
      window.workspaceBoardResizeObserver.observe(workspaceBoard);
    }
    byId('workspaceAddMemberBtn').onclick = () => openAddModal();
    byId('workspaceRefreshBtn').onclick = async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        await refreshAllWavuStats();
      } finally {
        button.disabled = false;
      }
    };
    byId('newListBtn').onclick = () => { closeWorkspaceMenus(); openListNameDialog('create'); };
    byId('renameListBtn').onclick = () => { closeWorkspaceMenus(); openListNameDialog('rename'); };
    byId('reorderListsBtn').onclick = () => { closeWorkspaceMenus(); openListOrderDialog(); };
    byId('deleteListBtn').onclick = () => { closeWorkspaceMenus(); deleteList(); };
    byId('shareListBtn').onclick = () => { closeWorkspaceMenus(); publishSharedListLink(); };
    byId('shareFileBtn').onclick = () => { closeWorkspaceMenus(); exportSharedList(); };
    byId('exportListBtn').onclick = () => { closeWorkspaceMenus(); exportList(); };
    byId('importListBtn').onclick = () => { closeWorkspaceMenus(); byId('importListFile').click(); };
    byId('importListFile').onchange = importList;
    byId('closeShareLinkBtn').onclick = closeShareLinkDialog;
    byId('closeShareLinkFooterBtn').onclick = closeShareLinkDialog;
    byId('copyShareLinkBtn').onclick = copyPublishedShareLink;
    byId('shareLinkDialog').addEventListener('click', event => {
      if (event.target === byId('shareLinkDialog')) closeShareLinkDialog();
    });
    byId('shareLinkDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeShareLinkDialog();
    });
    byId('closeListNameBtn').onclick = closeListNameDialog;
    byId('cancelListNameBtn').onclick = closeListNameDialog;
    byId('listNameForm').onsubmit = event => {
      event.preventDefault();
      saveListNameDialog();
    };
    byId('awardEnabledToggle').onchange = async event => {
      const requested = event.currentTarget.checked;
      event.currentTarget.checked = currentAwardEnabled;
      const decision = await confirmAwardToggle(requested);
      if (!decision) return;
      setAwardEnabled(requested, decision === 'reset').catch(error => showToast(`アワード設定の保存に失敗しました: ${error.message || error}`));
    };
    byId('showAwardsBtn').onclick = () => { closeWorkspaceMenus(); openLatestAwardResults(); };
    byId('listNameDialog').addEventListener('click', event => {
      if (event.target === byId('listNameDialog')) closeListNameDialog();
    });
    byId('listNameDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeListNameDialog();
    });
    byId('closeSharedImportConfirmBtn').onclick = () => closeSharedImportConfirmation(false);
    byId('cancelSharedImportConfirmBtn').onclick = () => closeSharedImportConfirmation(false);
    byId('confirmSharedImportBtn').onclick = () => closeSharedImportConfirmation(true);
    byId('sharedImportConfirmDialog').addEventListener('click', event => {
      if (event.target === byId('sharedImportConfirmDialog')) closeSharedImportConfirmation(false);
    });
    byId('sharedImportConfirmDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeSharedImportConfirmation(false);
    });
    byId('sharedImportConfirmDialog').addEventListener('close', () => {
      if (sharedImportConfirmResolve) closeSharedImportConfirmation(false, true);
    });
    const vsButton = byId('vsModeToggleBtn');
    if (vsButton) vsButton.onclick = toggleVsMode;
    const awardPlaybackButton = byId('awardPlaybackBtn');
    if (awardPlaybackButton) awardPlaybackButton.onclick = () => openLatestAwardResults();
    const communityQuickButton = byId('communityQuickBtn');
    if (communityQuickButton) communityQuickButton.onclick = openCommunityInsights;
    if (!document.body.dataset.vsInteractionGuardBound) {
      document.body.dataset.vsInteractionGuardBound = 'true';
      document.addEventListener('click', event => {
        if (!vsModeActive || byId('vsComparisonStage')) return;
        if (event.target.closest('#vsModeToggleBtn')) return;
        // Cross-list VS selection keeps every other command locked, but the
        // list selector remains available between the first and second pick.
        if (event.target.closest('#myListSelect')) return;
        const currentGrid = byId('posterGrid');
        const card = event.target.closest('#posterGrid > .poster-card');
        event.preventDefault();
        event.stopImmediatePropagation();
        if (card && card.parentElement === currentGrid) selectVsCard(memberKeyFromCard(card));
      }, true);
    }
    if (!document.body.dataset.vsEscapeBound) {
      document.body.dataset.vsEscapeBound = 'true';
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && (vsModeActive || byId('vsComparisonStage'))) closeVsComparison();
      });
      window.addEventListener('popstate', () => {
        if (window.workspaceMenuHistoryClosing) {
          window.workspaceMenuHistoryClosing = false;
          return;
        }
        const workspaceMenu = document.querySelector('.workspace-dropdown[open]');
        if (workspaceMenu) {
          window.workspaceMenuSuppressHistory = true;
          workspaceMenu.removeAttribute('open');
          queueMicrotask(() => { window.workspaceMenuSuppressHistory = false; });
          return;
        }
        if (byId('vsComparisonStage')) {
          closeVsComparison({ fromHistory: true });
          return;
        }
        const modal = document.querySelector('.modal-overlay.open');
        if (modal && typeof window.closeModal === 'function') {
          window.closeModal(modal.id, true);
          return;
        }
        const dialog = document.querySelector('dialog[open]');
        if (dialog?.id === 'mainCharacterLogicDialog' && typeof window.closeMainCharacterLogic === 'function') {
          window.closeMainCharacterLogic(true);
          return;
        }
        if (dialog) dialog.close();
      });
    }
    byId('memberSortMode').onchange = event => saveMemberSort(
      event.target.value,
      event.target.value === 'last_active' ? 'desc' : currentMemberSortDirection
    );
    byId('memberSortDirection').onclick = () => saveMemberSort(currentMemberSortMode, currentMemberSortDirection === 'asc' ? 'desc' : 'asc');
    byId('memberSortExcludeHistorical').onchange = event => { excludeHistoricalFromSkillSort = event.target.checked; saveMemberSort(currentMemberSortMode, currentMemberSortDirection); };
    updateMemberSortControls();
    byId('closeListOrderBtn').onclick = closeListOrderDialog;
    byId('cancelListOrderBtn').onclick = closeListOrderDialog;
    byId('saveListOrderBtn').onclick = saveListOrder;
    byId('listOrderDialog').addEventListener('click', event => {
      if (event.target === byId('listOrderDialog')) closeListOrderDialog();
    });
    byId('closeMemberTransferBtn').onclick = closeMemberTransferDialog;
    byId('cancelMemberTransferBtn').onclick = closeMemberTransferDialog;
    byId('executeMemberTransferBtn').onclick = executeMemberTransfer;
    byId('memberTransferDialog').addEventListener('click', event => {
      if (event.target === byId('memberTransferDialog')) closeMemberTransferDialog();
    });
    byId('memberTransferDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeMemberTransferDialog();
    });
    byId('memberTransferDialog').addEventListener('close', () => {
      pendingMemberTransfer = null;
    });
    let kentomoHelpSlide = 0;
    const showKentomoHelpSlide = next => {
      const slides = [...byId('kentomoHelpDialog').querySelectorAll('.kentomo-help-slide')];
      kentomoHelpSlide = Math.max(0, Math.min(slides.length - 1, next));
      slides.forEach((slide, index) => {
        slide.hidden = index !== kentomoHelpSlide;
        slide.classList.toggle('is-active', index === kentomoHelpSlide);
      });
      [...byId('kentomoHelpDots').querySelectorAll('button')].forEach((dot, index) => dot.classList.toggle('is-active', index === kentomoHelpSlide));
      byId('kentomoHelpPage').textContent = `${kentomoHelpSlide + 1} / ${slides.length}`;
      byId('kentomoHelpPrev').disabled = kentomoHelpSlide === 0;
      byId('kentomoHelpNext').textContent = kentomoHelpSlide === slides.length - 1 ? '最初へ ↺' : '次へ ›';
    };
    byId('kentomoHelpBtn').onclick = () => {
      closeWorkspaceMenus();
      byId('kentomoHelpDialog').showModal();
      showKentomoHelpSlide(0);
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'kentomoHelpDialog' }, '');
    };
    const closeKentomoHelp = () => {
      byId('kentomoHelpDialog').close();
      if (history.state?.kentomoOverlay === 'kentomoHelpDialog') history.back();
    };
    byId('closeKentomoHelpBtn').onclick = closeKentomoHelp;
    byId('dismissKentomoHelpBtn').onclick = closeKentomoHelp;
    byId('kentomoHelpPrev').onclick = () => showKentomoHelpSlide(kentomoHelpSlide - 1);
    byId('kentomoHelpNext').onclick = () => {
      const lastSlide = byId('kentomoHelpDialog').querySelectorAll('.kentomo-help-slide').length - 1;
      showKentomoHelpSlide(kentomoHelpSlide === lastSlide ? 0 : kentomoHelpSlide + 1);
    };
    [...byId('kentomoHelpDots').querySelectorAll('button')].forEach((dot, index) => {
      dot.onclick = () => showKentomoHelpSlide(index);
    });
    byId('kentomoHelpDialog').addEventListener('click', event => {
      if (event.target === byId('kentomoHelpDialog')) closeKentomoHelp();
    });
    byId('kentomoHelpDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeKentomoHelp();
    });
    let mainCharacterLogicReturnHandler = null;
    byId('mainCharacterLogicBtn').onclick = () => {
      closeWorkspaceMenus();
      mainCharacterLogicReturnHandler = null;
      byId('mainCharacterPlayerDiagnostics').hidden = true;
      byId('mainCharacterLogicTitle').textContent = 'メインキャラはどう決まる？';
      byId('mainCharacterLogicDialog').showModal();
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'mainCharacterLogicDialog' }, '');
    };
    window.openMainCharacterDetails = (member, stats, options = {}) => {
      const dialog = byId('mainCharacterLogicDialog');
      if (!dialog || !stats) return;
      mainCharacterLogicReturnHandler = typeof options.onClose === 'function' ? options.onClose : null;
      const playerName = String(member?.name || member?.autoName || member?.gameId || 'プレイヤー');
      const gameId = String(member?.gameId || stats?.gameId || '');
      const candidates = Array.isArray(stats.characterSelectionTop) && stats.characterSelectionTop.length
        ? stats.characterSelectionTop
        : [{
            position: 1, character: stats.mainChar, characterImage: stats.mainCharImage,
            selectionSource: stats.mainSelectionSource, ratingMu: stats.ratingMu,
            leaderboardGames: stats.leaderboardGames, lifetimeGames: stats.mainCharGames
          }];
      const sourceIsWavu = candidates[0]?.selectionSource === 'wavu-qualified-highest-mu';
      const ranking = byId('mainCharacterRanking');
      ranking.innerHTML = candidates.slice(0, 2).map((candidate, index) => {
        const label = index === 0 ? 'メインキャラ' : 'サブメイン候補';
        const candidateIsWavu = candidate.selectionSource === 'wavu-qualified-highest-mu';
        const metric = candidateIsWavu
          ? `Wavu μ ${Number(candidate.ratingMu).toLocaleString()}${candidate.leaderboardGames !== null && candidate.leaderboardGames !== undefined ? ` ／ Leaderboard ${Number(candidate.leaderboardGames).toLocaleString()}試合` : ''}`
          : `EWGF 生涯ランク戦 ${Number(candidate.lifetimeGames || 0).toLocaleString()}試合`;
        return `<article><span class="main-character-rank-number">${index + 1}</span><img src="${escapeHtml(candidate.characterImage || '')}" alt=""><div><small>${label}</small><strong>${escapeHtml(candidate.character || '不明')}</strong><p>${metric}</p></div></article>`;
      }).join('');
      byId('mainCharacterLogicTitle').textContent = `${playerName} のメインキャラ判定`;
      byId('mainCharacterDiagnosticPlayerName').textContent = playerName;
      byId('mainCharacterDiagnosticPlayerId').textContent = gameId ? `TEKKEN 8 ID：${gameId}` : 'TEKKEN 8 ID：不明';
      const first = candidates[0];
      const second = candidates[1];
      const secondUsesWavu = second?.selectionSource === 'wavu-qualified-highest-mu';
      byId('mainCharacterDiagnosticReason').textContent = sourceIsWavu
        ? `${first?.character || '1位のキャラ'}は、σ² < 75を満たす信頼できるWavu候補の中でμが最も高いためメイン判定です。${second ? (secondUsesWavu ? `${second.character}は同じ条件の中でμが2番目に高いため、サブメイン候補として表示しています。` : `信頼できるWavu候補に別キャラがいないため、EWGFの生涯ランク戦試合数が次に多い${second.character}をサブメイン候補として補完しています。`) : '別のサブメイン候補は確認できませんでした。'}`
        : `信頼できるWavu候補を確認できなかったため、EWGFの生涯ランク戦試合数で比較しました。${first?.character || '1位のキャラ'}が最多のためメイン判定です。${second ? `${second.character}は生涯試合数が2番目に多いため、サブメイン候補として表示しています。` : '生涯試合数を比較できる2番目のキャラは確認できませんでした。'}`;
      byId('mainCharacterPlayerDiagnostics').hidden = false;
      dialog.showModal();
      if (history.state?.kentomoOverlay !== 'mainCharacterLogicDialog') {
        history.pushState({ ...(history.state || {}), kentomoOverlay: 'mainCharacterLogicDialog' }, '');
      }
      byId('closeMainCharacterLogicBtn').focus();
    };
    const closeMainCharacterLogic = (fromHistory = false) => {
      const returnToPreviousView = mainCharacterLogicReturnHandler;
      mainCharacterLogicReturnHandler = null;
      byId('mainCharacterLogicDialog').close();
      if (!fromHistory && history.state?.kentomoOverlay === 'mainCharacterLogicDialog') history.back();
      if (typeof returnToPreviousView === 'function') requestAnimationFrame(returnToPreviousView);
    };
    window.closeMainCharacterLogic = closeMainCharacterLogic;
    byId('closeMainCharacterLogicBtn').onclick = closeMainCharacterLogic;
    byId('dismissMainCharacterLogicBtn').onclick = closeMainCharacterLogic;
    byId('mainCharacterLogicDialog').addEventListener('click', event => {
      if (event.target === byId('mainCharacterLogicDialog')) closeMainCharacterLogic();
    });
    byId('mainCharacterLogicDialog').addEventListener('cancel', event => {
      event.preventDefault();
      // Android may emit native dialog cancellation together with its
      // browser-back navigation. Do not consume another history entry here;
      // the popstate route closes the child and restores the player detail.
      closeMainCharacterLogic(true);
    });
    const openCameraHelp = () => {
      closeWorkspaceMenus();
      byId('cameraHelpDialog').showModal();
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'cameraHelpDialog' }, '');
    };
    const closeCameraHelp = () => {
      byId('cameraHelpDialog').close();
      if (history.state?.kentomoOverlay === 'cameraHelpDialog') history.back();
    };
    byId('cameraHelpBtn').onclick = openCameraHelp;
    byId('closeCameraHelpBtn').onclick = closeCameraHelp;
    byId('dismissCameraHelpBtn').onclick = closeCameraHelp;
    byId('cameraHelpDialog').addEventListener('click', event => {
      if (event.target === byId('cameraHelpDialog')) closeCameraHelp();
    });
    byId('cameraHelpDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeCameraHelp();
    });
    byId('dormantPlayerLogicBtn').onclick = () => {
      closeWorkspaceMenus();
      byId('dormantPlayerDiagnostics').hidden = true;
      byId('dormantPlayerLogicTitle').textContent = '休眠中プレイヤーはどう決まる？';
      byId('dormantPlayerLogicDialog').showModal();
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'dormantPlayerLogicDialog' }, '');
    };
    window.openDormantPlayerDetails = (member, stats) => {
      const dialog = byId('dormantPlayerLogicDialog');
      if (!dialog || !stats) return;
      const playerName = String(member?.name || member?.autoName || member?.gameId || 'プレイヤー');
      const gameId = String(member?.gameId || stats?.gameId || '');
      const games7d = Math.max(0, Number(stats.recentRankedGames7d || 0));
      const games30d = Math.max(0, Number(stats.recentRankedGames30d || 0));
      const sampleSize = Math.max(0, Number(stats.recentRankedSampleSize || 0));
      const formatActivityDate = value => {
        const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
        if (!Number.isFinite(timestamp) || timestamp <= 0) return '確認できず';
        return new Intl.DateTimeFormat('ja-JP', {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(new Date(timestamp));
      };
      const latestRanked = formatActivityDate(stats.latestRankedBattleAt);
      const latestBattle = formatActivityDate(Number(stats.lastSeenTimestamp || 0));
      const returnTracking = stats.returnTracking && typeof stats.returnTracking === 'object'
        ? stats.returnTracking : null;
      const returnVisible = Boolean(
        typeof window.isDormantReturnVisible === 'function'
        && window.isDormantReturnVisible(returnTracking)
      );
      const returnDays = typeof window.getDormantReturnElapsedDays === 'function'
        ? window.getDormantReturnElapsedDays(returnTracking) : 0;
      const returnedRanked = formatActivityDate(returnTracking?.returnedBattleAt);
      const staleSources = [];
      if (stats.rankIsAllTimeHighest) staleSources.push('現在段位を確認できず、All-time highest rank（過去最高段位）を表示している');
      if (stats.ratingIsHistorical) staleSources.push('現在有効なWavuレートを確認できず、過去のμを参考表示している');
      const activityReason = `直近7日は${games7d}試合で現役基準の3試合未満、直近30日は${games30d}試合で現役基準の10試合未満です`;
      const staleReason = staleSources.length
        ? `${staleSources.join('うえ、')}ため`
        : '現在値の鮮度を確認できないため';
      byId('dormantPlayerLogicTitle').textContent = returnVisible
        ? `${playerName} の復帰を確認`
        : `${playerName} の休眠判定`;
      byId('dormantDiagnosticPlayerName').textContent = playerName;
      byId('dormantDiagnosticPlayerId').textContent = gameId ? `TEKKEN 8 ID：${gameId}` : 'TEKKEN 8 ID：不明';
      byId('dormantRecent7d').textContent = `${games7d}試合`;
      byId('dormantRecent30d').textContent = `${games30d}試合`;
      byId('dormantLatestRanked').textContent = latestRanked;
      byId('dormantRankedSample').textContent = `取得できた直近ランクマ標本 ${sampleSize}件`;
      byId('dormantLatestBattle').textContent = latestBattle;
      byId('dormantLatestBattleType').textContent = stats.latestBattleType
        ? `種別：${stats.latestBattleType}${stats.latestBattleCharacter ? `／使用：${stats.latestBattleCharacter}` : ''}`
        : '対戦種別不明';
      byId('dormantDiagnosticReason').textContent = returnVisible
        ? `${returnDays ? `${returnDays}日ぶりに` : ''}新しいランクマッチを${returnedRanked}に確認したため、復帰として3日間だけ表示しています。${activityReason}。現役基準にはまだ届いていないため、休眠判定は継続中です。これは強さの評価ではなく、表示データの鮮度を区別するための判定です。`
        : `${activityReason}。さらに、${staleReason}、拳トモくんでは休眠中と判定しています。これは強さの評価ではなく、表示データの鮮度を区別するための判定です。`;
      byId('dormantPlayerDiagnostics').hidden = false;
      dialog.showModal();
      if (history.state?.kentomoOverlay !== 'dormantPlayerLogicDialog') {
        history.pushState({ ...(history.state || {}), kentomoOverlay: 'dormantPlayerLogicDialog' }, '');
      }
      byId('closeDormantPlayerLogicBtn').focus();
    };
    window.openDormantReturnDetails = (member, stats) => window.openDormantPlayerDetails(member, stats);
    const closeDormantPlayerLogic = () => {
      byId('dormantPlayerLogicDialog').close();
      if (history.state?.kentomoOverlay === 'dormantPlayerLogicDialog') history.back();
    };
    byId('closeDormantPlayerLogicBtn').onclick = closeDormantPlayerLogic;
    byId('dismissDormantPlayerLogicBtn').onclick = closeDormantPlayerLogic;
    byId('dormantPlayerLogicDialog').addEventListener('click', event => {
      if (event.target === byId('dormantPlayerLogicDialog')) closeDormantPlayerLogic();
    });
    byId('dormantPlayerLogicDialog').addEventListener('cancel', event => {
      event.preventDefault();
      closeDormantPlayerLogic();
    });
    byId('adminToolsToggleBtn').onclick = () => {
      const adminMenu = byId('adminToolsMenu');
      adminMenu.hidden = !adminMenu.hidden;
      byId('adminToolsToggleBtn').classList.toggle('open', !adminMenu.hidden);
    };
    byId('adminCacheResetBtn').onclick = () => {
      closeWorkspaceMenus();
      adminResetCurrentListCache();
    };
    byId('adminLocalCacheClearBtn').onclick = () => {
      closeWorkspaceMenus();
      adminClearLocalStatsCache(true);
    };
    byId('listOrderItems').addEventListener('click', event => {
      const button = event.target.closest('[data-list-move]');
      if (!button) return;
      moveListOrder(button.closest('[data-list-id]').dataset.listId, Number(button.dataset.listMove));
    });
    byId('listOrderItems').addEventListener('dragstart', event => {
      const row = event.target.closest('[data-list-id]');
      if (!row) return;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.listId);
    });
    byId('listOrderItems').addEventListener('dragend', event => {
      event.target.closest('[data-list-id]')?.classList.remove('is-dragging');
    });
    byId('listOrderItems').addEventListener('dragover', event => {
      if (event.target.closest('[data-list-id]')) event.preventDefault();
    });
    byId('listOrderItems').addEventListener('drop', event => {
      const target = event.target.closest('[data-list-id]');
      const sourceId = event.dataTransfer.getData('text/plain');
      if (!target || !sourceId || sourceId === target.dataset.listId) return;
      event.preventDefault();
      moveListOrderTo(sourceId, target.dataset.listId, event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2);
    });
    bar.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.onclick = () => {
        const theme = button.dataset.themeChoice;
        byId('themeSelectDropdown').value = theme;
        selectTheme(theme);
        closeWorkspaceMenus();
      };
    });
    byId('logoutBtn').onclick = () => {
      closeWorkspaceMenus();
      if (activeUser && activeUser.isAnonymous) window.openGoogleAccountLogin();
      else auth.signOut();
    };
    if (window.workspaceOutsideClickHandler) {
      document.removeEventListener('click', window.workspaceOutsideClickHandler);
    }
    window.workspaceOutsideClickHandler = event => {
      if (!bar.contains(event.target)) closeWorkspaceMenus();
    };
    document.addEventListener('click', window.workspaceOutsideClickHandler);
  }

  function bindSharedStatus() {
    if (connectionStatusRef) connectionStatusRef.off();
    connectionStatusRef = db.ref('.info/connected');
    connectionStatusRef.on('value', snap => {
      byId('statusDot')?.classList.toggle('offline', snap.val() !== true);
      if (byId('statusText')) byId('statusText').textContent = snap.val() === true ? 'PRIVATE ONLINE' : 'OFFLINE';
    });
    updateLastUpdateLogBadge();
  }

  function teardownUserWorkspace() {
    if (listsRef) listsRef.off();
    if (listIndexRef) listIndexRef.off();
    if (listListenerRef) listListenerRef.off();
    if (settingsLogRef) settingsLogRef.off();
    if (memberSortRef) memberSortRef.off();
    if (connectionStatusRef) connectionStatusRef.off();
    sharedListSyncTimers.forEach(timer => clearTimeout(timer));
    sharedListSyncTimers.clear();
    sharedListSyncSignatures.clear();
    pendingSharedListSources.clear();
    sharedListMirrorCache.clear();
    accountPlayerLocations = new Map();
    connectionStatusRef = null;
    if (window.mobileCardResizeObserver) {
      window.mobileCardResizeObserver.disconnect();
      window.mobileCardResizeObserver = null;
    }
    if (window.workspaceGridResizeHandler) {
      window.removeEventListener('resize', window.workspaceGridResizeHandler);
      window.workspaceGridResizeHandler = null;
    }
    if (window.workspaceMenuPositionHandler) {
      window.removeEventListener('resize', window.workspaceMenuPositionHandler);
      window.removeEventListener('scroll', window.workspaceMenuPositionHandler);
      window.workspaceMenuPositionHandler = null;
    }
    if (window.workspaceOutsideClickHandler) {
      document.removeEventListener('click', window.workspaceOutsideClickHandler);
      window.workspaceOutsideClickHandler = null;
    }
    byId('listWorkspace')?.remove();
    byId('sharedListViewBanner')?.remove();
    document.body.classList.remove('workspace-ui-active', 'shared-list-readonly');
    resetVsMode();
    activeListId = null;
    listsRef = null;
    listIndexRef = null;
    listIndexEnabled = false;
    listListenerRef = null;
    settingsLogRef = null;
    memberSortRef = null;
    membersRef = null;
    settingsRef = null;
    currentListEntries = [];
    listMenuSignature = '';
    memberRenderSignature = '';
    sharedListView = null;
    window.currentMembersData = null;
    window.currentMembersLoaded = false;
    window.privateListStorageScope = '';
  }

  function renderListOrderItems() {
    const root = byId('listOrderItems');
    if (!root) return;
    root.innerHTML = listOrderDraft.map((item, index) => `
      <li draggable="true" data-list-id="${item.id}" class="${item.id === activeListId ? 'is-active' : ''}">
        <span class="list-order-grip" aria-hidden="true">⠿</span>
        <span class="list-order-name">${escapeHtml(item.name || '名称未設定')}</span>
        <span class="list-order-current">${item.id === activeListId ? '表示中' : ''}</span>
        <button type="button" data-list-move="-1" aria-label="上へ" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-list-move="1" aria-label="下へ" ${index === listOrderDraft.length - 1 ? 'disabled' : ''}>↓</button>
      </li>`).join('');
  }

  function openListOrderDialog() {
    listOrderDraft = currentListEntries.map(item => ({ ...item }));
    renderListOrderItems();
    byId('listOrderDialog').showModal();
    history.pushState({ ...(history.state || {}), kentomoOverlay: 'listOrderDialog' }, '');
  }

  function closeListOrderDialog() {
    byId('listOrderDialog')?.close();
    if (history.state?.kentomoOverlay === 'listOrderDialog') history.back();
  }

  function moveListOrder(listId, direction) {
    const from = listOrderDraft.findIndex(item => item.id === listId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= listOrderDraft.length) return;
    const [item] = listOrderDraft.splice(from, 1);
    listOrderDraft.splice(to, 0, item);
    renderListOrderItems();
  }

  function moveListOrderTo(sourceId, targetId, after) {
    const from = listOrderDraft.findIndex(item => item.id === sourceId);
    if (from < 0) return;
    const [item] = listOrderDraft.splice(from, 1);
    let to = listOrderDraft.findIndex(entry => entry.id === targetId);
    if (to < 0) return;
    if (after) to += 1;
    listOrderDraft.splice(to, 0, item);
    renderListOrderItems();
  }

  async function saveListOrder() {
    const button = byId('saveListOrderBtn');
    button.disabled = true;
    try {
      const updates = {};
      listOrderDraft.forEach((item, index) => {
        const order = (index + 1) * 1000;
        updates[`users/${activeUser.uid}/lists/${item.id}/order`] = order;
        if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${item.id}/order`] = order;
      });
      await db.ref().update(updates);
      closeListOrderDialog();
      showToast('マイリストの並び順を保存しました');
    } catch (error) {
      showToast(`並び順の保存に失敗しました: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }
  const listIndexEntry = (listId, list) => ({
    name: safeName(list?.name) || '名称未設定',
    order: Number(list?.order || Date.now()),
    createdAt: Number(list?.createdAt || Date.now()),
    memberCount: Number.isFinite(Number(list?.memberCount))
      ? Math.max(0, Number(list.memberCount))
      : Object.keys(list?.members || {}).length,
    ...(validSharedListId(list?.shareId) ? { shareId: validSharedListId(list.shareId) } : {}),
    ...(Number(list?.sharedCreatedAt) ? { sharedCreatedAt: Number(list.sharedCreatedAt) } : {}),
    ...(list?.awardEnabled === true ? { awardEnabled: true } : {}),
    ...(isSharedFavoriteRecord(listId, list) ? { isFavorite: true } : {})
  });

  let awardEnabledRef = null;
  let currentAwardEnabled = false;
  let latestAwardRun = null;
  let latestAwardPeriod = '';
  function updateAwardControls(enabled = false) {
    currentAwardEnabled = enabled === true;
    const toggle = byId('awardEnabledToggle');
    const note = byId('awardEnabledNote');
    if (toggle) toggle.checked = currentAwardEnabled;
    if (note) note.textContent = currentAwardEnabled
      ? '有効です。月初・月末にサーバーが自動記録し、月末にアワードを確定します。'
      : '月初と月末にサーバーが自動で記録します。リストを開かなくても動作します。';
  }

  const KENTOMO_WORKER_URL = 'https://tight-bar-55c1.uracil123.workers.dev';
  function activeShareId() {
    return validSharedListId(sharedListView?.id || currentListEntries.find(entry => entry.id === activeListId)?.shareId);
  }
  function communityVisitorId() {
    const key = 'kentomo_shared_access_visitor_v1';
    let value = localStorage.getItem(key);
    if (!value) {
      value = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem(key, value);
    }
    return value;
  }
  function trackSharedListVisit(shareId) {
    if (!validSharedListId(shareId)) return;
    fetch(`${KENTOMO_WORKER_URL}/?mode=track-shared-access&shareId=${encodeURIComponent(shareId)}&visitor=${encodeURIComponent(communityVisitorId())}`, { cache: 'no-store', keepalive: true })
      .catch(error => console.warn('Shared access tracking failed', error));
  }
  function communityCharacterDistribution(members) {
    const counts = new Map(); let active = 0; let signals = 0; let mainRankedGames = 0; let mainRankedGamesMembers = 0; let totalRankedAndPlayerGames = 0; let totalRankedAndPlayerGamesMembers = 0; let totalRecordedGames = 0; let totalRecordedGamesMembers = 0;
    Object.values(members || {}).forEach(member => {
      const stats = memberStats(member);
      const mainGames = Number(stats.mainCharGames);
      if (Number.isFinite(mainGames) && mainGames >= 0) {
        mainRankedGames += mainGames;
        mainRankedGamesMembers += 1;
      }
      const totalGames = Number(stats.totalRankedAndPlayerGames);
      if (Number.isFinite(totalGames) && totalGames >= 0) {
        totalRankedAndPlayerGames += totalGames;
        totalRankedAndPlayerGamesMembers += 1;
      }
      const recordedGames = Number(stats.totalRecordedGames);
      if (Number.isFinite(recordedGames) && recordedGames >= 0) {
        totalRecordedGames += recordedGames;
        totalRecordedGamesMembers += 1;
      }
      const candidates = (Array.isArray(stats.characterSelectionTop) ? stats.characterSelectionTop : [])
        .map(candidate => ({ character: String(candidate?.character || '').trim(), image: String(candidate?.characterImage || '').trim() }))
        .filter(candidate => candidate.character);
      if (!candidates.length && stats.mainChar) candidates.push({ character: String(stats.mainChar), image: String(stats.mainCharImage || '') });
      const distinct = new Map(); candidates.slice(0, 2).forEach((candidate, index) => distinct.set(candidate.character, { ...candidate, weight: index === 0 ? 1 : 0.5 }));
      distinct.forEach(({ character, image, weight }) => {
        const current = counts.get(character) || { points: 0, mainCount: 0, subCount: 0, image: '' };
        counts.set(character, { points: current.points + weight, mainCount: current.mainCount + (weight === 1 ? 1 : 0), subCount: current.subCount + (weight === .5 ? 1 : 0), image: current.image || image }); signals += weight;
      });
      if (window.hasRecentRankedActivity?.(stats)) active += 1;
    });
    const sorted = [...counts.entries()].sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0], 'ja'));
    const memberCount = Object.keys(members || {}).length;
    const [favorite, favoriteData] = sorted[0] || ['集計中', { points: 0, mainCount: 0, subCount: 0, image: '' }];
    const chartEntries = sorted.slice(0, 5).map(([character, value]) => ({ character, ...value }));
    const visiblePoints = chartEntries.reduce((sum, entry) => sum + entry.points, 0);
    if (signals > visiblePoints) chartEntries.push({ character: 'その他', points: signals - visiblePoints, mainCount: 0, subCount: 0, image: '' });
    return { memberCount, active, characterCount: counts.size, mainRankedGames, mainRankedGamesMembers, totalRankedAndPlayerGames, totalRankedAndPlayerGamesMembers, totalRecordedGames, totalRecordedGamesMembers, favorite, favoriteData, favoritePoints: favoriteData.points, favoriteImage: favoriteData.image, favoritePercent: signals ? Math.round(favoriteData.points / signals * 100) : 0, signals, chartEntries };
  }
  async function openCommunityInsights() {
    const shareId = activeShareId();
    const community = communityCharacterDistribution(window.currentMembersData || {});
    const listName = safeName(sharedListView?.name || currentListEntries.find(entry => entry.id === activeListId)?.name) || 'マイリスト';
    const dialog = document.createElement('dialog');
    dialog.className = 'community-insights-dialog';
    dialog.innerHTML = '<form method="dialog"><button class="community-insights-close" aria-label="閉じる">×</button><p class="community-insights-kicker">COMMUNITY PROFILE</p><h2></h2><p class="community-insights-lead"></p><section class="community-access-grid"></section><section class="community-pie-layout"><div class="community-pie-chart"><div class="community-pie-center"><img alt=""><strong></strong><span></span></div></div><ul class="community-pie-legend"></ul></section><section class="community-community-grid"></section><p class="community-insights-note"></p></form>';
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    const stat = (label, value, note = '') => `<div><small>${label}</small><strong>${value}</strong>${note ? `<em>${note}</em>` : ''}</div>`;
    dialog.querySelector('h2').textContent = `ひとくち勢力図 / ${listName}`;
    dialog.querySelector('.community-insights-lead').textContent = shareId ? '共有リストのアクセス概算と、メンバー構成です' : 'メンバー構成です。共有URLを作成するとアクセス概算も表示します。';
    const colors = ['#a78bfa', '#67e8f9', '#fde68a', '#fb7185', '#86efac', '#94a3b8'];
    const total = Math.max(1, community.chartEntries.reduce((sum, entry) => sum + entry.points, 0));
    let cursor = 0;
    const stops = community.chartEntries.map((entry, index) => { const start = cursor; cursor += entry.points / total * 100; return `${colors[index % colors.length]} ${start}% ${cursor}%`; });
    const pie = dialog.querySelector('.community-pie-chart');
    pie.style.setProperty('--community-pie', `conic-gradient(${stops.join(',') || '#334155 0 100%'})`);
    const centerImage = pie.querySelector('.community-pie-center img');
    centerImage.src = community.favoriteImage || '';
    centerImage.hidden = !community.favoriteImage;
    pie.querySelector('strong').textContent = community.favorite;
    pie.querySelector('span').textContent = `${community.favoritePoints.toFixed(1)}pt / ${community.favoritePercent}%`;
    dialog.querySelector('.community-pie-legend').innerHTML = community.chartEntries.map((entry, index) => `<li><i style="--community-color:${colors[index % colors.length]}"></i>${entry.image ? `<img src="${escapeHtml(entry.image)}" alt="">` : '<span class="community-pie-no-image">?</span>'}<b>${escapeHtml(entry.character)}<em>メイン ${entry.mainCount || 0}人 / サブ ${entry.subCount || 0}人</em></b><small>${entry.points.toFixed(1)}pt</small></li>`).join('') || '<li>キャラ情報を取得中です</li>';
    const estimatedHours = Math.round(community.totalRecordedGames * 2.5 / 6) / 10;
    dialog.querySelector('.community-community-grid').innerHTML = [stat('現役率', `${community.memberCount ? Math.round(community.active / community.memberCount * 100) : 0}%`), stat('現役メンバー', `${community.active} / ${community.memberCount}人`), stat('確認キャラ数', `${community.characterCount}キャラ`), stat('メインランクマ合計', `${Math.round(community.mainRankedGames).toLocaleString()}戦`), stat('全プレイヤー総試合数', `${Math.round(community.totalRecordedGames).toLocaleString()}戦`, `全マッチング · 推定 ${estimatedHours.toLocaleString()}時間`), stat('メンバー', `${community.memberCount}人`)].join('');
    dialog.showModal();
    const communityNote = `円グラフはメインを1pt、サブ候補を0.5ptとして、各プレイヤー最大2キャラまで合算。メインランクマ合計は確認できた${community.mainRankedGamesMembers}/${community.memberCount}人、全プレイヤー総試合数は確認できた${community.totalRecordedGamesMembers}/${community.memberCount}人の試合数です。総試合数はランクマ・プレマ・クイック・グループの全マッチングを合算。推定対戦時間は1試合約2.5分で換算しており、ロード・待機・トレーニング時間は含みません。`;
    if (!shareId) { dialog.querySelector('.community-access-grid').hidden = true; dialog.querySelector('.community-insights-note').textContent = communityNote; return; }
    try {
      const response = await fetch(`${KENTOMO_WORKER_URL}/?mode=shared-access-summary&shareId=${encodeURIComponent(shareId)}`, { cache: 'no-store' });
      const access = await response.json();
      if (!access.ok) throw new Error(access.error || 'アクセス数を取得できません');
      dialog.querySelector('.community-access-grid').innerHTML = [stat('累計閲覧', Number(access.views || 0).toLocaleString()), stat('ユニーク閲覧（概算）', Number(access.uniqueVisitors || 0).toLocaleString()), stat('直近7日', Number(access.last7Days || 0).toLocaleString()), stat('今日', Number(access.today || 0).toLocaleString())].join('');
      dialog.querySelector('.community-insights-note').textContent = `${communityNote} 閲覧は端末内の匿名IDを日次で重複排除し、IPや生の識別子は保存しません。`;
    } catch (error) {
      dialog.querySelector('.community-insights-lead').textContent = 'アクセス数は次回の自動同期後に表示されます';
      dialog.querySelector('.community-access-grid').innerHTML = stat('状態', '取得待ち');
    }
  }

  function confirmAwardToggle(enable) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'award-confirm-dialog';
      dialog.innerHTML = enable
        ? '<form method="dialog"><h2>拳トモ・アワードを開始しますか？</h2><p>月初・月末にサーバーが自動で記録します。リストを開き続ける必要はありません。</p><menu><button value="cancel">キャンセル</button><button value="keep" class="award-confirm-primary">有効にする</button></menu></form>'
        : '<form method="dialog"><h2>拳トモ・アワードを停止しますか？</h2><p>途中の記録を残せば、同じ月に再開できます。</p><menu><button value="cancel">キャンセル</button><button value="reset" class="award-confirm-danger">今月の記録も削除</button><button value="keep" class="award-confirm-primary">記録を残して停止</button></menu></form>';
      document.body.appendChild(dialog);
      dialog.addEventListener('close', () => { const value = dialog.returnValue; dialog.remove(); resolve(value === 'keep' || value === 'reset' ? value : ''); }, { once: true });
      dialog.showModal();
    });
  }

  function updateAwardPlaybackButton() {
    const button = byId('awardPlaybackBtn');
    if (!button) return;
    button.hidden = !latestAwardRun;
    button.title = latestAwardPeriod ? `${latestAwardPeriod} の拳トモ・アワードを再生` : '拳トモ・アワードを再生';
  }

  async function loadLatestAwardRun(listId = activeListId, promptOnFirstVisit = false) {
    if (!activeUser || !listId || listId !== activeListId) return null;
    try {
      const snapshot = await db.ref(`awardRuns/${activeUser.uid}/${listId}`).once('value');
      if (listId !== activeListId) return null;
      const complete = Object.entries(snapshot.val() || {})
        .filter(([, run]) => run?.status === 'complete' && Array.isArray(run?.results?.categories))
        .sort(([a], [b]) => b.localeCompare(a, 'en'))[0];
      latestAwardPeriod = complete?.[0] || '';
      latestAwardRun = complete?.[1] || null;
      updateAwardPlaybackButton();
      if (promptOnFirstVisit && latestAwardRun) maybePromptAwardPlayback();
      return latestAwardRun;
    } catch (error) {
      console.warn('Award result load failed', error);
      latestAwardPeriod = '';
      latestAwardRun = null;
      updateAwardPlaybackButton();
      return null;
    }
  }

  function maybePromptAwardPlayback() {
    if (!activeUser || !activeListId || !latestAwardRun || !latestAwardPeriod) return;
    const seenKey = `kentomo_award_prompt_${activeUser.uid}_${activeListId}_${latestAwardPeriod}`;
    if (localStorage.getItem(seenKey)) return;
    localStorage.setItem(seenKey, '1');
    const dialog = document.createElement('dialog');
    dialog.className = 'award-confirm-dialog award-arrival-dialog';
    dialog.innerHTML = '<form method="dialog"><h2>前月の集計が完了しています</h2><p>このマイリストは拳トモ・アワードが有効です。拳トモアワードを表示しますか？</p><menu><button value="cancel">あとで見る</button><button value="play" class="award-confirm-primary">表示する</button></menu></form>';
    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => {
      const shouldPlay = dialog.returnValue === 'play';
      dialog.remove();
      if (shouldPlay) openLatestAwardResults();
    }, { once: true });
    dialog.showModal();
  }

  async function setAwardEnabled(enabled, resetCurrent = false) {
    if (!activeUser || !activeListId || !settingsRef) return;
    const listId = activeListId;
    const now = Date.now();
    const schedule = {
      enabled: enabled === true,
      updatedAt: now,
      ...(enabled ? { createdAt: now } : {}),
      ...(!enabled && resetCurrent ? { resetRequestedAt: now } : {})
    };
    const updates = {
      [`users/${activeUser.uid}/lists/${listId}/awardEnabled`]: enabled === true,
      [`awardSchedules/${activeUser.uid}/${listId}`]: schedule
    };
    if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${listId}/awardEnabled`] = enabled === true;
    await db.ref().update(updates);
    updateAwardControls(enabled);
    showToast(enabled
      ? '拳トモ・アワードを有効にしました。次回の自動処理から記録します。'
      : (resetCurrent ? '停止しました。今月の記録は次回の自動処理で削除されます。' : '停止しました。今月の記録は保持されます。'));
  }

  async function openLatestAwardResults() {
    if (!activeUser || !activeListId) return;
    try {
      const run = latestAwardRun || await loadLatestAwardRun();
      const period = latestAwardPeriod;
      if (!run) return showToast('確定済みのアワードはまだありません。月初・月末の自動記録後に表示されます。');
      openAwardSlideshow(period, run);
    } catch (error) {
      showToast(`アワード結果を読み込めませんでした: ${error.message || error}`);
    }
  }

  function openAwardSlideshow(period, run) {
    document.getElementById('kentomoAwardSlideshow')?.remove();
    const categories = run?.results?.categories || [];
    const slides = [
      { kind: 'intro', kicker: 'KENTOMO AWARDS', title: '拳トモ<br>アワード', caption: `${escapeHtml(period)} / 対象 ${Number(run?.results?.eligiblePlayers || 0)}人` },
      ...categories.map(category => {
        const promotion = category.promotion;
        return { kind: 'award', kicker: escapeHtml(category.title || 'MONTHLY AWARD'), title: escapeHtml(category.name || '該当者なし'), caption: promotion ? `${escapeHtml(promotion.character || '')}　${escapeHtml(promotion.fromRank || '—')} → ${escapeHtml(promotion.toRank || '—')}` : `${Number(category.value || 0).toLocaleString()}${escapeHtml(category.suffix || '')}` };
      }),
      { kind: 'end', kicker: 'THANK YOU FOR FIGHTING', title: 'また来月。', caption: '拳トモ・アワード' }
    ];
    let index = 0;
    let timer = null;
    const overlay = document.createElement('section');
    overlay.id = 'kentomoAwardSlideshow';
    overlay.className = 'kentomo-award-slideshow';
    overlay.innerHTML = '<div class="kentomo-award-diagonal" aria-hidden="true"></div><button type="button" class="kentomo-award-close" aria-label="アワードを閉じる">×</button><button type="button" class="kentomo-award-nav kentomo-award-prev" aria-label="前へ">‹</button><button type="button" class="kentomo-award-nav kentomo-award-next" aria-label="次へ">›</button><div class="kentomo-award-stage" aria-live="polite"></div><div class="kentomo-award-progress"></div><p class="kentomo-award-hint">TAP / CLICK TO ADVANCE</p>';
    document.body.appendChild(overlay);
    const stage = overlay.querySelector('.kentomo-award-stage');
    const progress = overlay.querySelector('.kentomo-award-progress');
    const render = () => {
      const slide = slides[index];
      stage.innerHTML = `<article class="kentomo-award-slide kentomo-award-${slide.kind}"><p class="kentomo-award-kicker">${slide.kicker}</p><h2>${slide.title}</h2><p class="kentomo-award-caption">${slide.caption}</p></article>`;
      progress.innerHTML = slides.map((_, i) => `<i class="${i === index ? 'is-current' : ''}"></i>`).join('');
      requestAnimationFrame(() => stage.firstElementChild?.classList.add('is-visible'));
    };
    const schedule = () => { clearTimeout(timer); if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setTimeout(() => { index = (index + 1) % slides.length; render(); schedule(); }, 6000); };
    const move = amount => { index = (index + amount + slides.length) % slides.length; render(); schedule(); };
    const close = () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); overlay.remove(); };
    const onKey = event => { if (event.key === 'Escape') close(); else if (event.key === 'ArrowRight') move(1); else if (event.key === 'ArrowLeft') move(-1); };
    overlay.querySelector('.kentomo-award-close').onclick = close;
    overlay.querySelector('.kentomo-award-next').onclick = () => move(1);
    overlay.querySelector('.kentomo-award-prev').onclick = () => move(-1);
    stage.onclick = () => move(1);
    document.addEventListener('keydown', onKey);
    render();
    schedule();
  }
  async function updateWithOptionalListIndex(updates) {
    try {
      await db.ref().update(updates);
      return true;
    } catch (error) {
      const permissionDenied = /permission_denied/i.test(String(error?.code || error?.message || error));
      const legacyUpdates = Object.fromEntries(
        Object.entries(updates || {}).filter(([path]) => !path.includes('/listIndex/'))
      );
      if (!permissionDenied || Object.keys(legacyUpdates).length === Object.keys(updates || {}).length) throw error;
      await db.ref().update(legacyUpdates);
      console.warn('Firebase Rules do not allow listIndex yet; used legacy list writes');
      return false;
    }
  }

  async function enableLightweightListIndex() {
    listIndexRef = db.ref(`users/${activeUser.uid}/listIndex`);
    try {
      const indexSnapshot = await listIndexRef.once('value');
      if (indexSnapshot.exists()) {
        listIndexEnabled = true;
        return true;
      }
      // Existing accounts migrate once. From the next launch, only listIndex
      // and the currently opened members node are downloaded.
      const listsSnapshot = await listsRef.once('value');
      const lists = listsSnapshot.val() || {};
      if (!Object.keys(lists).length) {
        const ref = listsRef.push();
        const now = Date.now();
        await db.ref().update({
          [`users/${activeUser.uid}/lists/${ref.key}`]: {
            name: 'マイリスト 1', order: now, createdAt: firebase.database.ServerValue.TIMESTAMP
          },
          [`users/${activeUser.uid}/listIndex/${ref.key}`]: {
            name: 'マイリスト 1', order: now, createdAt: now, memberCount: 0
          }
        });
      } else {
        const index = Object.fromEntries(
          Object.entries(lists).map(([listId, list]) => [listId, listIndexEntry(listId, list)])
        );
        await listIndexRef.set(index);
      }
      listIndexEnabled = true;
      return true;
    } catch (error) {
      // Safe rollout before the new Rules are published.
      console.warn('Lightweight list index unavailable; using legacy list subscription', error);
      listIndexRef = null;
      listIndexEnabled = false;
      return false;
    }
  }

  async function handleListCatalog(lists, includesMembers = false) {
      const { own: entries, favorites: favoriteEntries } = splitListEntries(lists);
      const ownLists = Object.fromEntries(entries);
      if (includesMembers) {
        accountPlayerLocations = new Map();
        entries.forEach(([listId, list]) => {
          Object.entries(list?.members || {}).forEach(([memberId, member]) => {
            const normalizedId = cleanTekkenId(member?.gameId).toUpperCase();
            if (!normalizedId) return;
            const locations = accountPlayerLocations.get(normalizedId) || [];
            locations.push({ listId, memberId });
            accountPlayerLocations.set(normalizedId, locations);
          });
          scheduleSharedListSync(listId, list);
        });
      }
      currentListEntries = entries.map(([id, list]) => ({
        id,
        name: list.name || '名称未設定',
        memberCount: Number.isFinite(Number(list.memberCount)) ? Number(list.memberCount) : Object.keys(list.members || {}).length,
        order: Number(list.order || 0),
        createdAt: Number(list.createdAt || 0),
        shareId: validSharedListId(list.shareId),
        sharedCreatedAt: Number(list.sharedCreatedAt || 0)
      }));
      const nextListMenuSignature = JSON.stringify({
        own: JSON.parse(createListMenuSignature(entries)),
        favorites: favoriteEntries.map(([, favorite]) => [favorite.shareId, favorite.name, favorite.order])
      });
      if (!entries.length) {
        const ref = listsRef.push();
        const now = Date.now();
        await ref.set({ name: 'マイリスト 1', order: now, createdAt: firebase.database.ServerValue.TIMESTAMP });
        if (listIndexEnabled) await listIndexRef.child(ref.key).set({
          name: 'マイリスト 1', order: now, createdAt: now, memberCount: 0
        });
        return;
      }
      const select = byId('myListSelect');
      if (nextListMenuSignature !== listMenuSignature) {
        listMenuSignature = nextListMenuSignature;
        renderListSelectOptions(select, entries, favoriteEntries);
      }
      let desiredListId = ownLists[activeListId]
        ? activeListId
        : (localStorage.getItem(`active_list_${activeUser.uid}`) || entries[0][0]);
      if (!ownLists[desiredListId]) desiredListId = entries[0][0];
      select.value = desiredListId;
      if (activeListId === desiredListId) applyActiveListName(lists[desiredListId].name);
      activateList(desiredListId);
  }

  async function subscribeLists() {
    if (await enableLightweightListIndex()) {
      listIndexRef.on('value', snapshot => {
        handleListCatalog(snapshot.val() || {}, false).catch(error => console.error('List index update failed', error));
      });
      return;
    }
    listsRef.on('value', snapshot => {
      handleListCatalog(snapshot.val() || {}, true).catch(error => console.error('Legacy list update failed', error));
    });
  }

  window.syncPlayerNameAcrossLists = async function syncPlayerNameAcrossLists(gameId, nameFields) {
    if (!listsRef || !activeUser || sharedListView) return 0;
    const normalizedId = cleanTekkenId(gameId).toUpperCase();
    if (!normalizedId) return 0;
    const allowedFields = [
      'name', 'autoName', 'nameMode', 'nameSource',
      'nameUpdatedAt', 'autoNameUpdatedAt'
    ];
    const fields = Object.fromEntries(
      allowedFields
        .filter(field => nameFields?.[field] !== undefined)
        .map(field => [field, nameFields[field]])
    );
    if (!Object.keys(fields).length) return 0;
    const updates = {};
    let locations = accountPlayerLocations.get(normalizedId) || [];
    if (listIndexEnabled) {
      const snapshot = await listsRef.once('value');
      locations = [];
      Object.entries(snapshot.val() || {}).forEach(([listId, list]) => {
        Object.entries(list?.members || {}).forEach(([memberId, member]) => {
          if (cleanTekkenId(member?.gameId).toUpperCase() === normalizedId) locations.push({ listId, memberId });
        });
      });
      accountPlayerLocations.set(normalizedId, locations);
    }
    locations.forEach(({ listId, memberId }) => {
      Object.entries(fields).forEach(([field, value]) => {
        updates[`${listId}/members/${memberId}/${field}`] = value;
      });
    });
    if (locations.length) await listsRef.update(updates);
    return locations.length;
  };

  function activateList(listId) {
    if (!listId) return;
    const nextMembersRef = listsRef.child(listId).child('members');
    const sameSubscription = activeListId === listId
      && listListenerRef
      && listListenerRef.toString() === nextMembersRef.toString();
    if (sameSubscription) return;

    if (listListenerRef) listListenerRef.off();
    if (settingsLogRef) settingsLogRef.off();
    if (memberSortRef) memberSortRef.off();
    if (awardEnabledRef) awardEnabledRef.off();
    if (!vsModeActive) resetVsMode();
    activeListId = listId;
    localStorage.setItem(`active_list_${activeUser.uid}`, listId);
    membersRef = nextMembersRef;
    settingsRef = listsRef.child(listId);
    listListenerRef = nextMembersRef;
    settingsLogRef = settingsRef.child('last_update_log');
    memberSortRef = settingsRef.child('memberSort');
    awardEnabledRef = settingsRef.child('awardEnabled');
    latestAwardRun = null;
    latestAwardPeriod = '';
    updateAwardPlaybackButton();
    awardEnabledRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      const enabled = snapshot.val() === true;
      updateAwardControls(enabled);
      if (enabled) loadLatestAwardRun(listId, true);
    });
    window.privateListStorageScope = `${activeUser.uid}_${listId}`;

    window.currentMembersData = null;
    window.currentMembersLoaded = false;
    memberRenderSignature = '';
    updateLastUpdateLogBadge();
    settingsLogRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      updateLastUpdateLogBadge(snapshot.val());
    });
    memberSortRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      const remoteSetting = snapshot.val();
      const setting = readLocalMemberSort() || remoteSetting || {};
      currentMemberSortMode = ['manual','name','rank','games','total_games','rating','winrate','power','last_active','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'].includes(setting.mode) ? setting.mode : 'manual';
      currentMemberSortDirection = setting.direction === 'asc' ? 'asc' : 'desc';
      excludeHistoricalFromSkillSort = setting.excludeHistorical === true;
      if (remoteSetting) writeLocalMemberSort(currentMemberSortMode, currentMemberSortDirection);
      window.memberAutoSortActive = currentMemberSortMode !== 'manual';
      updateMemberSortControls();
      if (window.currentMembersData && !window.cardReorderInProgress) { renderPosters(window.currentMembersData); setTimeout(addPerCardListActions, 0); }
    });
    renderPosters(null);
    if (vsModeActive && vsSelectedKeys.length === 1) {
      showToast('別のマイリストから対戦相手を選べます');
    }
    byId('loadingState').style.display = '';

    const subscribedListId = listId;
    settingsRef.child('name').once('value').then(snapshot => {
      if (activeListId !== subscribedListId) return;
      const name = snapshot.val() || 'マイリスト';
      applyActiveListName(name);

    });
    nextMembersRef.on('value', snapshot => {
      if (activeListId !== subscribedListId || listListenerRef !== nextMembersRef) return;
      const members = snapshot.val();
      const nextMemberRenderSignature = createMemberRenderSignature(members);
      const isStatsOnlyUpdate = Boolean(memberRenderSignature)
        && nextMemberRenderSignature === memberRenderSignature;
      byId('loadingState').style.display = 'none';
      window.currentMembersData = members;
      window.currentMembersLoaded = true;
      setTimeout(() => optimizeOversizedMemberPhotos(members), 0);
      const memberCount = Object.keys(members || {}).length;
      const activeEntry = currentListEntries.find(entry => entry.id === subscribedListId);
      if (activeEntry && activeEntry.memberCount !== memberCount) {
        activeEntry.memberCount = memberCount;
        if (listIndexEnabled) listIndexRef.child(subscribedListId).child('memberCount').set(memberCount)
          .catch(error => console.warn('List member count index update failed', error));
      }
      if (activeEntry?.shareId) {
        scheduleSharedListSync(subscribedListId, {
          ...activeEntry,
          members,
          shareId: activeEntry.shareId,
          sharedCreatedAt: activeEntry.sharedCreatedAt
        });
      }
      if (isStatsOnlyUpdate) {
        patchVisibleAutoNames(members);
        if (typeof window.refreshVisibleStats === 'function') window.refreshVisibleStats();
        if (window.memberAutoSortActive) {
          requestAnimationFrame(() => {
            const grid = byId('posterGrid');
            if (!grid || window.cardReorderInProgress) return;
            const manualEntries = Object.entries(members || {}).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
            const sortedEntries = typeof window.sortMemberEntries === 'function'
              ? window.sortMemberEntries(manualEntries)
              : manualEntries;
            const cards = new Map([...grid.querySelectorAll(':scope > .poster-card')]
              .map(card => [card.dataset.memberKey, card]));
            const fragment = document.createDocumentFragment();
            sortedEntries.forEach(([key]) => {
              const card = cards.get(key);
              if (card) fragment.appendChild(card);
            });
            grid.appendChild(fragment);
          });
        }
        return;
      }
      memberRenderSignature = nextMemberRenderSignature;
      renderPosters(members);
      setTimeout(() => {
        if (activeListId !== subscribedListId) return;
        addPerCardListActions();
        scheduleOwnedListProfileRefresh(subscribedListId, members);
        if (Object.values(members || {}).some(member => !String(member?.autoName || '').trim())) {
          scheduleLatestBattleRefresh(800, true, true);
        }
      }, 0);
    });
  }
  let listNameDialogMode = 'create';

  function openListNameDialog(mode) {
    const dialog = byId('listNameDialog');
    const input = byId('listNameInput');
    listNameDialogMode = mode === 'rename' ? 'rename' : 'create';
    const isRename = listNameDialogMode === 'rename';
    const current = currentListEntries.find(item => item.id === activeListId)?.name || 'マイリスト';
    byId('listNameDialogTitle').textContent = isRename ? 'リスト名を変更' : '新しいリスト';
    byId('listNameDialogDescription').textContent = isRename
      ? '現在のマイリストに新しい名前を付けます'
      : '作成するマイリストの名前を入力してください';
    byId('saveListNameBtn').textContent = isRename ? '変更を保存' : '作成';
    input.value = isRename ? current : '新しいマイリスト';
    dialog.showModal();
    history.pushState({ ...(history.state || {}), kentomoOverlay: 'listNameDialog' }, '');
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  function closeListNameDialog(fromHistory = false) {
    byId('listNameDialog')?.close();
    if (!fromHistory && history.state?.kentomoOverlay === 'listNameDialog') history.back();
  }

  async function saveListNameDialog() {
    const name = safeName(byId('listNameInput').value);
    if (!name) {
      byId('listNameInput').focus();
      return showToast('リスト名を入力してください');
    }
    const button = byId('saveListNameBtn');
    button.disabled = true;
    try {
      if (listNameDialogMode === 'rename') await renameList(name);
      else await createList(name);
      closeListNameDialog();
    } catch (error) {
      showToast(`リスト名を保存できませんでした: ${error.message || error}`);
    } finally {
      button.disabled = false;
    }
  }

  async function createList(name) {
    const ref = listsRef.push();
    const now = Date.now();
    const updates = {
      [`users/${activeUser.uid}/lists/${ref.key}`]: {
        name, order: now, createdAt: firebase.database.ServerValue.TIMESTAMP
      }
    };
    if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${ref.key}`] = {
      name, order: now, createdAt: now, memberCount: 0, awardEnabled: false
    };
    await db.ref().update(updates);
    activateList(ref.key);
    const select = byId('myListSelect');
    if (select && [...select.options].some(option => option.value === ref.key)) {
      select.value = ref.key;
    }
    showToast(`${name} を作成しました`);
  }

  async function renameList(name) {
    if (!activeListId) return;
    const updates = { [`users/${activeUser.uid}/lists/${activeListId}/name`]: name };
    if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${activeListId}/name`] = name;
    await db.ref().update(updates);
    applyActiveListName(name);
    const activeEntry = currentListEntries.find(entry => entry.id === activeListId);
    if (activeEntry) {
      activeEntry.name = name;
      if (activeEntry.shareId) scheduleSharedListSync(activeListId, {
        ...activeEntry,
        name,
        members: window.currentMembersData || {}
      });
    }
    showToast('リスト名を変更しました');
  }

  async function deleteList() {
    const select = byId('myListSelect');
    if (currentListEntries.length <= 1) return showToast('最後の1件は削除できません');
    const name = select.selectedOptions[0]?.textContent || 'このリスト';
    if (!confirm(`${name} を削除しますか？`)) return;
    const snapshot = await listsRef.child(activeListId).once('value');
    const source = snapshot.val() || {};
    const shareId = validSharedListId(source.shareId);
    if (shareId) {
      const updates = {
        [`users/${activeUser.uid}/lists/${activeListId}`]: null,
        [`sharedLists/${shareId}`]: null
      };
      if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${activeListId}`] = null;
      await db.ref().update(updates);
      sharedListSyncSignatures.delete(activeListId);
    } else {
      const updates = { [`users/${activeUser.uid}/lists/${activeListId}`]: null };
      if (listIndexEnabled) updates[`users/${activeUser.uid}/listIndex/${activeListId}`] = null;
      await db.ref().update(updates);
    }
    activeListId = null;
    showToast('リストを削除しました');
  }

  async function exportList() {
    const listCount = currentListEntries.length;
    if (!listCount) return showToast('バックアップするマイリストがありません');
    if (!confirm(`現在あるすべてのマイリスト（${listCount}件）をバックアップします。\nよろしいですか？`)) return;
    const snapshot = await listsRef.once('value');
    const payload = { version: 1, exportedAt: new Date().toISOString(), lists: snapshot.val() || {} };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tekken8-mylists-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function sanitizeSharedMembers(members, includeFetchedStats = true) {
    const allowed = [
      'name', 'autoName', 'nameMode', 'nameSource', 'nameUpdatedAt', 'autoNameUpdatedAt',
      'gameId', 'subtitle', 'xUrl', 'countryCode', 'photoData', 'color', 'order'
    ];
    return Object.fromEntries(Object.entries(members || {}).map(([id, member]) => {
      const clean = {};
      for (const key of allowed) if (member[key] !== undefined) clean[key] = member[key];
      if (includeFetchedStats && member?.fetchedStats && typeof member.fetchedStats === 'object' && Object.keys(member.fetchedStats).length) {
        clean.fetchedStats = member.fetchedStats;
      }
      return [id, clean];
    }));
  }

  const validSharedListId = value => {
    const normalized = String(value || '');
    return /^[A-Za-z0-9_-]{16,64}$/.test(normalized) ? normalized : '';
  };
  const sharedFavoriteKey = shareId => `favorite_${validSharedListId(shareId)}`;
  const isSharedFavoriteRecord = (listId, source) => {
    if (source?.isFavorite === true) return true;
    // listIndex deliberately omits members. Its explicit memberCount means
    // absence of members must not turn an owned published list into a favorite.
    if (Number.isFinite(Number(source?.memberCount))) return false;
    const shareId = validSharedListId(source?.shareId);
    if (!shareId || source?.sharedCreatedAt) return false;
    return String(listId || '').startsWith('favorite_') || !Object.keys(source?.members || {}).length;
  };
  const splitListEntries = lists => {
    const sorted = Object.entries(lists || {}).sort((a, b) => (a[1]?.order || 0) - (b[1]?.order || 0));
    return {
      own: sorted.filter(([id, list]) => !isSharedFavoriteRecord(id, list)),
      favorites: sorted.filter(([id, list]) => isSharedFavoriteRecord(id, list))
    };
  };
  const renderListSelectOptions = (select, ownEntries, favoriteEntries, currentShare = null) => {
    const ownOptions = ownEntries.map(([id, list]) => {
      const count = Number.isFinite(Number(list?.memberCount))
        ? Number(list.memberCount)
        : Object.keys(list?.members || {}).length;
      return `<option value="${escapeHtml(id)}">${escapeHtml(list?.name || '名称未設定')} · ${count} players</option>`;
    }).join('');
    const favoriteOptions = favoriteEntries.map(([, favorite]) =>
      `<option value="shared:${escapeHtml(validSharedListId(favorite?.shareId))}">★ ${escapeHtml(favorite?.name || '共有リスト')}</option>`
    ).join('');
    const currentIsSaved = currentShare && favoriteEntries.some(([, favorite]) =>
      validSharedListId(favorite?.shareId) === currentShare.id
    );
    const currentOption = currentShare && !currentIsSaved
      ? `<optgroup label="閲覧中"><option value="shared:${escapeHtml(currentShare.id)}">☆ ${escapeHtml(currentShare.name)}</option></optgroup>`
      : '';
    select.innerHTML =
      `<optgroup label="自分のマイリスト">${ownOptions}</optgroup>` +
      (favoriteOptions ? `<optgroup label="★ 共有お気に入り">${favoriteOptions}</optgroup>` : '') +
      currentOption;
  };

  const sharedListContentSignature = source => JSON.stringify({
    name: safeName(source?.name) || 'マイリスト',
    members: sanitizeSharedMembers(source?.members)
  });

  const sharedListPayload = (source, includeFetchedStats = true) => ({
    ownerUid: activeUser.uid,
    name: safeName(source?.name) || 'マイリスト',
    members: sanitizeSharedMembers(source?.members, includeFetchedStats),
    createdAt: Number(source?.sharedCreatedAt || 0) || firebase.database.ServerValue.TIMESTAMP,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  });
  const comparableSharedPayload = source => ({
    name: safeName(source?.name) || 'マイリスト',
    members: sanitizeSharedMembers(source?.members)
  });
  async function writeSharedListDelta(shareId, previous, next) {
    const updates = {};
    if (previous.name !== next.name) updates[`sharedLists/${shareId}/name`] = next.name;
    const previousMembers = previous.members || {};
    const nextMembers = next.members || {};
    const memberIds = new Set([...Object.keys(previousMembers), ...Object.keys(nextMembers)]);
    memberIds.forEach(memberId => {
      const before = previousMembers[memberId];
      const after = nextMembers[memberId];
      if (!after) {
        updates[`sharedLists/${shareId}/members/${memberId}`] = null;
        return;
      }
      if (!before) {
        updates[`sharedLists/${shareId}/members/${memberId}`] = after;
        return;
      }
      const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
      fields.forEach(field => {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
          updates[`sharedLists/${shareId}/members/${memberId}/${field}`] =
            after[field] === undefined ? null : after[field];
        }
      });
    });
    if (!Object.keys(updates).length) return false;
    updates[`sharedLists/${shareId}/updatedAt`] = firebase.database.ServerValue.TIMESTAMP;
    await db.ref().update(updates);
    return true;
  }
  const sharedPayloadHasStats = payload => Object.values(payload?.members || {}).some(member => member?.fetchedStats);
  async function writeSharedListPayload(shareId, payload) {
    try {
      await db.ref(`sharedLists/${shareId}`).set(payload);
      return true;
    } catch (error) {
      const permissionDenied = /permission_denied/i.test(String(error?.code || error?.message || error));
      if (!permissionDenied || !sharedPayloadHasStats(payload)) throw error;
      await db.ref(`sharedLists/${shareId}`).set({
        ...payload,
        members: sanitizeSharedMembers(payload.members, false)
      });
      console.warn('Firebase Rules do not allow shared fetchedStats yet; used legacy shared payload');
      return false;
    }
  }

  function scheduleSharedListSync(listId, source) {
    const shareId = validSharedListId(source?.shareId);
    if (!shareId || !activeUser || sharedListView || isSharedFavoriteRecord(listId, source)) return;
    const signature = sharedListContentSignature(source);
    if (sharedListSyncSignatures.get(listId) === signature) return;
    pendingSharedListSources.set(listId, { source, shareId, signature });
    clearTimeout(sharedListSyncTimers.get(listId));
    sharedListSyncTimers.set(listId, setTimeout(async () => {
      sharedListSyncTimers.delete(listId);
      const pending = pendingSharedListSources.get(listId);
      pendingSharedListSources.delete(listId);
      if (!pending || !activeUser || sharedListView) return;
      try {
        const nextPayload = comparableSharedPayload(pending.source);
        let previousPayload = sharedListMirrorCache.get(listId);
        if (!previousPayload) {
          const snapshot = await db.ref(`sharedLists/${pending.shareId}`).once('value');
          const remote = snapshot.val();
          previousPayload = remote
            ? comparableSharedPayload(remote)
            : { name: '', members: {} };
        }
        await writeSharedListDelta(pending.shareId, previousPayload, nextPayload);
        sharedListMirrorCache.set(listId, nextPayload);
        sharedListSyncSignatures.set(listId, pending.signature);
      } catch (error) {
        console.warn(`Shared list auto-sync failed for ${listId}`, error);
      }
    }, 450));
  }

  const sharedListIdFromUrl = () => {
    const value = new URLSearchParams(location.search).get('list') || '';
    return /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : '';
  };

  const sharedListUrl = shareId =>
    `${location.origin}${location.pathname}?list=${encodeURIComponent(shareId)}`;

  function closeShareLinkDialog(fromHistory = false) {
    byId('shareLinkDialog')?.close();
    if (!fromHistory && history.state?.kentomoOverlay === 'shareLinkDialog') history.back();
  }

  async function copyPublishedShareLink() {
    const input = byId('shareLinkUrl');
    const value = input?.value || '';
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast('共有URLをコピーしました');
    } catch (_) {
      input.focus();
      input.select();
      if (!document.execCommand('copy')) prompt('このURLをコピーしてください', value);
      else showToast('共有URLをコピーしました');
    }
  }

  function openShareLinkDialog(url) {
    const dialog = byId('shareLinkDialog');
    byId('shareLinkUrl').value = url;
    dialog.showModal();
    if (history.state?.kentomoOverlay !== 'shareLinkDialog') {
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'shareLinkDialog' }, '');
    }
    byId('copyShareLinkBtn').focus();
  }

  async function publishSharedListLink() {
    if (!activeListId || !activeUser || sharedListView) return;
    const button = byId('shareListBtn');
    if (button) {
      button.disabled = true;
      button.textContent = '共有リンクを準備中…';
    }
    try {
      const snapshot = await listsRef.child(activeListId).once('value');
      const source = snapshot.val();
      if (!source) return showToast('共有するリストがありません');
      const listName = safeName(source.name) || 'マイリスト';
      const members = sanitizeSharedMembers(source.members);
      let shareId = validSharedListId(source.shareId)
        ? String(source.shareId)
        : db.ref('sharedLists').push().key;
      const payload = {
        ownerUid: activeUser.uid,
        name: listName,
        members,
        createdAt: Number(source.sharedCreatedAt || 0) || firebase.database.ServerValue.TIMESTAMP,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      };
      try {
        await writeSharedListPayload(shareId, payload);
      } catch (error) {
        // A stale/imported shareId must not block publishing. Generate a fresh,
        // unguessable Firebase push ID and try once more.
        if (!source.shareId || !/permission_denied/i.test(String(error?.code || error?.message || error))) throw error;
        shareId = db.ref('sharedLists').push().key;
        await writeSharedListPayload(shareId, payload);
      }
      await listsRef.child(activeListId).update({
        shareId,
        sharedCreatedAt: Number(source.sharedCreatedAt || 0) || firebase.database.ServerValue.TIMESTAMP
      });
      if (listIndexEnabled) {
        await listIndexRef.child(activeListId).update({
          shareId,
          sharedCreatedAt: Number(source.sharedCreatedAt || 0) || Date.now()
        });
      }
      sharedListSyncSignatures.set(activeListId, sharedListContentSignature(source));
      sharedListMirrorCache.set(activeListId, comparableSharedPayload({ name: listName, members }));
      const url = sharedListUrl(shareId);
      openShareLinkDialog(url);
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      showToast('閲覧専用の共有リンクを作成しました');
    } catch (error) {
      console.error('Shared list publishing failed', error);
      showToast(`共有リンクを作成できませんでした: ${error.message || error}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '🔗 閲覧専用の共有リンクを作成';
      }
    }
  }

  async function exportSharedList() {
    if (!activeListId) return;
    const snapshot = await listsRef.child(activeListId).once('value');
    const source = snapshot.val();
    if (!source) return showToast('共有するリストがありません');
    const listName = safeName(source.name) || 'マイリスト';
    const payload = {
      format: 'tekken8-shared-list', version: 1, exportedAt: new Date().toISOString(),
      list: { name: listName, members: sanitizeSharedMembers(source.members) }
    };
    const filename = `${listName.replace(/[\\/:*?"<>|]/g, '_')}-tekken8-list.json`;
    downloadJson(payload, filename);
    showToast('共有ファイルを出力しました');
  }
  async function importList(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format === 'tekken8-shared-list' && data.version === 1 && data.list) {
        const listName = safeName(data.list.name) || '共有リスト';
        const members = sanitizeSharedMembers(data.list.members);
        const memberCount = Object.keys(members).length;
        if (!confirm(`「${listName}」を新しいリストとして取り込みますか？\n登録人数: ${memberCount}人`)) return;
        const ref = listsRef.push();
        await ref.set({
          name: `${listName} (共有)`, order: Date.now(),
          createdAt: firebase.database.ServerValue.TIMESTAMP, members
        });
        if (listIndexEnabled) await listIndexRef.child(ref.key).set({
          name: `${listName} (共有)`, order: Date.now(), createdAt: Date.now(), memberCount
        });
        activateList(ref.key);
        showToast('共有リストを取り込みました');
        return;
      }

      const backupLists = Object.entries(data.lists || {});
      if (!backupLists.length) throw new Error('対応しているリストデータがありません');
      if (!confirm(`このJSONデータにはマイリスト・共有お気に入りが計${backupLists.length}件入っています。\n読み込んでよろしいですか？`)) return;
      for (const [sourceId, list] of backupLists) {
        if (isSharedFavoriteRecord(sourceId, list)) {
          const favoriteId = sharedFavoriteKey(list.shareId);
          const favorite = {
            name: safeName(list.name) || '共有リスト',
            order: Number(list.order || Date.now()),
            createdAt: Number(list.createdAt || Date.now()),
            shareId: validSharedListId(list.shareId)
          };
          await listsRef.child(favoriteId).set(favorite);
          if (listIndexEnabled) await listIndexRef.child(favoriteId).set({ ...favorite, memberCount: 0, isFavorite: true });
          continue;
        }
        const ref = listsRef.push();
        const imported = { ...list, name: `${safeName(list.name) || 'インポート'} (取込)`, order: Date.now() };
        await ref.set(imported);
        if (listIndexEnabled) await listIndexRef.child(ref.key).set(listIndexEntry(ref.key, imported));
      }
      showToast('バックアップをインポートしました');
    } catch (error) {
      showToast(`取込エラー: ${error.message}`);
    }
  }

  let sharedImportConfirmResolve = null;
  function closeSharedImportConfirmation(confirmed = false, fromHistory = false) {
    const dialog = byId('sharedImportConfirmDialog');
    const resolve = sharedImportConfirmResolve;
    sharedImportConfirmResolve = null;
    if (dialog?.open) dialog.close();
    if (resolve) resolve(Boolean(confirmed));
    if (!fromHistory && history.state?.kentomoOverlay === 'sharedImportConfirmDialog') history.back();
  }
  function confirmSharedListImport() {
    if (!sharedListView || !activeUser) return Promise.resolve(false);
    const dialog = byId('sharedImportConfirmDialog');
    const listName = safeName(sharedListView.name) || '共有リスト';
    const guest = activeUser.isAnonymous;
    byId('sharedImportConfirmMessage').innerHTML = guest
      ? `<strong>「${escapeHtml(listName)}」をゲスト用マイリストへ取り込みますか？</strong><span>現在はゲストモードです。Googleでログインすれば、マイリストをアカウント別に保存し、スマホやPCなど端末間で同期することもできます。</span>`
      : `<strong>「${escapeHtml(listName)}」を自分のアカウントへ取り込みますか？</strong><span>取り込み後は編集できますが、元の共有リストの変更には追従しない独立したコピーになります。</span>`;
    byId('confirmSharedImportBtn').textContent = guest
      ? 'ゲストのマイリストへ取り込む'
      : '自分のマイリストへ取り込む';
    dialog.showModal();
    if (history.state?.kentomoOverlay !== 'sharedImportConfirmDialog') {
      history.pushState({ ...(history.state || {}), kentomoOverlay: 'sharedImportConfirmDialog' }, '');
    }
    return new Promise(resolve => { sharedImportConfirmResolve = resolve; });
  }

  async function importSharedListView() {
    if (!sharedListView || !activeUser) return;
    if (!await confirmSharedListImport()) return;
    const button = byId('importSharedListViewBtn');
    if (button) {
      button.disabled = true;
      button.textContent = '取り込み中…';
    }
    try {
      const ownListsRef = db.ref(`users/${activeUser.uid}/lists`);
      const ref = ownListsRef.push();
      const now = Date.now();
      const imported = {
        name: `${safeName(sharedListView.name) || '共有リスト'} (共有)`,
        order: now,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        members: sanitizeSharedMembers(sharedListView.members)
      };
      await updateWithOptionalListIndex({
        [`users/${activeUser.uid}/lists/${ref.key}`]: imported,
        [`users/${activeUser.uid}/listIndex/${ref.key}`]: {
          name: imported.name, order: now, createdAt: now,
          memberCount: Object.keys(imported.members || {}).length
        }
      });
      localStorage.setItem(`active_list_${activeUser.uid}`, ref.key);
      const url = new URL(location.href);
      url.searchParams.delete('list');
      location.replace(url.toString());
    } catch (error) {
      console.error('Shared list import failed', error);
      showToast(`マイリストへ取り込めませんでした: ${error.message || error}`);
      if (button) {
        button.disabled = false;
        button.textContent = 'このリストを取り込む';
      }
    }
  }

  async function refreshSharedFavoriteNavigation() {
    if (!activeUser || !sharedListView) return;
    let snapshot;
    try {
      const indexSnapshot = await db.ref(`users/${activeUser.uid}/listIndex`).once('value');
      snapshot = indexSnapshot.exists()
        ? indexSnapshot
        : await db.ref(`users/${activeUser.uid}/lists`).once('value');
    } catch (_) {
      snapshot = await db.ref(`users/${activeUser.uid}/lists`).once('value');
    }
    const { own, favorites } = splitListEntries(snapshot.val() || {});
    const savedEntry = favorites.find(([, favorite]) => validSharedListId(favorite?.shareId) === sharedListView.id);
    if (savedEntry && safeName(savedEntry[1]?.name) !== safeName(sharedListView.name)) {
      savedEntry[1].name = safeName(sharedListView.name) || '共有リスト';
      updateWithOptionalListIndex({
        [`users/${activeUser.uid}/lists/${savedEntry[0]}/name`]: savedEntry[1].name,
        [`users/${activeUser.uid}/listIndex/${savedEntry[0]}/name`]: savedEntry[1].name
      })
        .catch(error => console.warn('Shared favorite name sync failed', error));
    }
    const select = byId('myListSelect');
    renderListSelectOptions(select, own, favorites, sharedListView);
    select.value = `shared:${sharedListView.id}`;
    select.disabled = false;
    const saved = favorites.some(([, favorite]) => validSharedListId(favorite?.shareId) === sharedListView.id);
    const button = byId('favoriteSharedListBtn');
    if (button) {
      button.dataset.saved = String(saved);
      button.classList.toggle('is-favorite', saved);
      button.textContent = saved ? '★ お気に入り登録済み（解除）' : '☆ この共有リストをお気に入りに登録';
    }
  }

  async function toggleSharedListFavorite() {
    if (!activeUser || !sharedListView) return;
    const button = byId('favoriteSharedListBtn');
    if (button) button.disabled = true;
    try {
      const ref = db.ref(`users/${activeUser.uid}/lists/${sharedFavoriteKey(sharedListView.id)}`);
      const snapshot = await ref.once('value');
      const favoriteId = sharedFavoriteKey(sharedListView.id);
      if (snapshot.exists()) {
        await updateWithOptionalListIndex({
          [`users/${activeUser.uid}/lists/${favoriteId}`]: null,
          [`users/${activeUser.uid}/listIndex/${favoriteId}`]: null
        });
        showToast('共有リストをお気に入りから解除しました');
      } else {
        const now = Date.now();
        const favorite = {
          name: safeName(sharedListView.name) || '共有リスト',
          order: now,
          createdAt: firebase.database.ServerValue.TIMESTAMP,
          shareId: sharedListView.id
        };
        await updateWithOptionalListIndex({
          [`users/${activeUser.uid}/lists/${favoriteId}`]: favorite,
          [`users/${activeUser.uid}/listIndex/${favoriteId}`]: {
            name: favorite.name, order: now, createdAt: now,
            shareId: favorite.shareId, memberCount: 0, isFavorite: true
          }
        });
        showToast('共有リストをお気に入りに登録しました');
      }
      await refreshSharedFavoriteNavigation();
    } catch (error) {
      console.error('Shared list favorite update failed', error);
      showToast(`お気に入りを更新できませんでした: ${error.message || error}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function returnToOwnLists() {
    const url = new URL(location.href);
    url.searchParams.delete('list');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    location.reload();
  }
  function memberKeyFromCard(card) {
    if (card.dataset.memberKey) return card.dataset.memberKey;
    const edit = card.querySelector('[onclick^="openEditModal"]');
    return edit?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1] || '';
  }

  async function persistCardOrder(grid) {
    const updates = {};
    [...grid.querySelectorAll(':scope > .poster-card')].forEach((card, index) => {
      const key = memberKeyFromCard(card);
      if (key) updates[`${key}/order`] = (index + 1) * 1000;
    });
    if (!Object.keys(updates).length) return;
    try {
      await membersRef.update(updates);
      showToast('メンバーの並び順を保存しました');
    } catch (error) {
      showToast(`並び順の保存に失敗しました: ${error.message}`);
      const snapshot = await membersRef.once('value');
      renderPosters(snapshot.val());
      setTimeout(addPerCardListActions, 0);
    }
  }

  function bindCardReorder(handle, card) {
    const grid = card.parentElement;
    let pointerId = null;
    let moved = false;
    let slot = null;
    let originRect = null;
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    let dragX = 0;
    let dragY = 0;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let committedPointerX = null;
    let committedPointerY = null;
    let pendingGap = null;
    let pendingGapTimer = null;
    const shiftAnimations = new WeakMap();

    const clearPendingGap = () => {
      if (pendingGapTimer) clearTimeout(pendingGapTimer);
      pendingGapTimer = null;
      pendingGap = null;
    };

    const animateGridShift = before => {
      [...grid.querySelectorAll(':scope > .poster-card')].forEach(item => {
        const first = before.get(item);
        if (!first) return;
        const last = item.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (!dx && !dy) return;
        const previous = shiftAnimations.get(item);
        if (previous) previous.cancel();
        const animation = item.animate(
          [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }],
          { duration: 340, easing: 'cubic-bezier(.16,.82,.22,1)' }
        );
        shiftAnimations.set(item, animation);
        animation.finished.finally(() => {
          if (shiftAnimations.get(item) === animation) shiftAnimations.delete(item);
        }).catch(() => {});
      });
    };

    const clearFloatingStyles = () => {
      for (const property of ['position','left','top','width','height','margin','zIndex','pointerEvents','transform','transition']) {
        card.style[property] = '';
      }
      card.classList.remove('card-reordering');
    };

    const updateDropSlot = (clientX, clientY, force = false) => {
      if (!slot) return false;
      const probeX = clientX - grabOffsetX + originRect.width / 2;
      const probeY = clientY - grabOffsetY + originRect.height / 2;
      const slotRect = slot.getBoundingClientRect();
      const pointerInsideSlot =
        probeX >= slotRect.left && probeX <= slotRect.right &&
        probeY >= slotRect.top && probeY <= slotRect.bottom;
      if (pointerInsideSlot) {
        clearPendingGap();
        return false;
      }
      const cards = [...grid.querySelectorAll(':scope > .poster-card')];
      if (!cards.length) return false;
      const measured = cards.map(item => ({ item, rect: item.getBoundingClientRect() }));
      const nearest = measured.reduce((best, candidate) => {
        const centerX = candidate.rect.left + candidate.rect.width / 2;
        const centerY = candidate.rect.top + candidate.rect.height / 2;
        const dx = (probeX - centerX) / Math.max(candidate.rect.width, 1);
        const dy = (probeY - centerY) / Math.max(candidate.rect.height, 1);
        const distance = dx * dx + dy * dy;
        return !best || distance < best.distance ? { ...candidate, distance } : best;
      }, null);
      const targetIndex = cards.indexOf(nearest.item);
      const centerX = nearest.rect.left + nearest.rect.width / 2;
      const centerY = nearest.rect.top + nearest.rect.height / 2;
      const columnCount = getComputedStyle(grid).gridTemplateColumns
        .split(/\s+/)
        .filter(Boolean).length;
      const insertBefore = columnCount > 1 ? probeX < centerX : probeY < centerY;
      const firstRect = measured[0].rect;
      const lastRect = measured[measured.length - 1].rect;
      const beforeFirstZone = probeY <= firstRect.bottom && probeX <= firstRect.left + firstRect.width * 0.35;
      const afterLastZone =
        probeY > lastRect.bottom + lastRect.height * 0.2 ||
        (probeY >= lastRect.top - lastRect.height * 0.35 && probeX >= lastRect.left + lastRect.width * 0.35);
      const desiredGap = beforeFirstZone
        ? 0
        : afterLastZone
          ? cards.length
          : targetIndex + (insertBefore ? 0 : 1);
      const isWideBoundaryZone = beforeFirstZone || afterLastZone;
      const children = [...grid.children];
      const slotPosition = children.indexOf(slot);
      const currentGap = children.slice(0, slotPosition)
        .filter(item => item.classList.contains('poster-card')).length;
      if (desiredGap === currentGap) {
        clearPendingGap();
        return false;
      }
      if (!force && !isWideBoundaryZone) {
        lastPointerX = clientX;
        lastPointerY = clientY;
        if (committedPointerX !== null) {
          const movedSinceCommit = Math.hypot(
            clientX - committedPointerX,
            clientY - committedPointerY
          );
          if (movedSinceCommit < 28) {
            clearPendingGap();
            return false;
          }
        }
        if (pendingGap !== desiredGap) {
          clearPendingGap();
          pendingGap = desiredGap;
          pendingGapTimer = setTimeout(() => {
            if (pointerId !== null && pendingGap === desiredGap) {
              updateDropSlot(lastPointerX, lastPointerY, true);
            }
          }, 100);
        }
        return false;
      }
      clearPendingGap();

      const before = new Map(measured.map(({ item, rect }) => [item, rect]));
      if (desiredGap >= cards.length) grid.appendChild(slot);
      else grid.insertBefore(slot, cards[desiredGap]);
      committedPointerX = clientX;
      committedPointerY = clientY;
      animateGridShift(before);
      moved = true;
      return true;
    };
    const finish = async event => {
      if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      const finalPlacementChanged = event.type === 'pointerup'
        ? updateDropSlot(event.clientX, event.clientY, true)
        : false;
      try { handle.releasePointerCapture(pointerId); } catch (e) {}
      pointerId = null;
      grid.classList.remove('card-reorder-active');
      if (finalPlacementChanged) await new Promise(resolve => setTimeout(resolve, 120));

      if (slot && originRect) {
        const destination = slot.getBoundingClientRect();
        const targetX = destination.left - originRect.left;
        const targetY = destination.top - originRect.top;
        const animation = card.animate(
          [
            { transform: `translate3d(${dragX}px,${dragY}px,0) scale(1.035)` },
            { transform: `translate3d(${targetX}px,${targetY}px,0) scale(1)` }
          ],
          { duration: 210, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' }
        );
        await animation.finished.catch(() => {});
        slot.replaceWith(card);
        slot = null;
        clearFloatingStyles();
      }
      if (moved) await persistCardOrder(grid);
      moved = false;
      endCardReorder();
    };

    handle.addEventListener('pointerdown', event => {
      if (currentMemberSortMode !== 'manual') return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointerId = event.pointerId;
      moved = false;
      originRect = card.getBoundingClientRect();
      grabOffsetX = event.clientX - originRect.left;
      grabOffsetY = event.clientY - originRect.top;
      dragX = 0;
      dragY = 0;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      committedPointerX = null;
      committedPointerY = null;
      clearPendingGap();
      beginCardReorder();

      slot = document.createElement('div');
      slot.className = 'card-drop-slot';
      slot.style.height = `${originRect.height}px`;
      card.before(slot);
      Object.assign(card.style, {
        position: 'fixed', left: `${originRect.left}px`, top: `${originRect.top}px`,
        width: `${originRect.width}px`, height: `${originRect.height}px`, margin: '0',
        zIndex: '20000', pointerEvents: 'none', transform: 'translate3d(0,0,0) scale(1.035)',
        transition: 'none'
      });
      document.body.appendChild(card);
      handle.setPointerCapture(pointerId);
      card.classList.add('card-reordering');
      grid.classList.add('card-reorder-active');
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId || !slot) return;
      event.preventDefault();
      dragX = event.clientX - originRect.left - grabOffsetX;
      dragY = event.clientY - originRect.top - grabOffsetY;
      card.style.transform = `translate3d(${dragX}px,${dragY}px,0) scale(1.035)`;

      if (event.clientY < 72) window.scrollBy(0, -12);
      else if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 12);

      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      updateDropSlot(lastPointerX, lastPointerY);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', async event => {
      if (currentMemberSortMode !== 'manual') return;
      if (!['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const previous = card.previousElementSibling;
      const next = card.nextElementSibling;
      if ((event.key === 'ArrowUp' || event.key === 'ArrowLeft') && previous?.classList.contains('poster-card')) {
        previous.before(card);
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowRight') && next?.classList.contains('poster-card')) {
        next.after(card);
      } else {
        return;
      }
      await persistCardOrder(grid);
    });
  }
  function addPerCardListActions() {
    if (sharedListView) {
      document.querySelectorAll('.card-reorder-handle, .list-card-actions').forEach(element => element.remove());
    }
    document.querySelectorAll('.poster-card').forEach(card => {
      const key = memberKeyFromCard(card);
      if (!key) return;
      card.dataset.memberKey = key;

      if (!sharedListView && !card.querySelector('.card-reorder-handle')) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'card-reorder-handle';
        handle.textContent = '⠿';
        handle.title = 'ドラッグまたはスワイプして並べ替え';
        handle.setAttribute('aria-label', 'メンバーの位置を並べ替え');
        card.prepend(handle);
        bindCardReorder(handle, card);
      }
      const reorderHandle = card.querySelector('.card-reorder-handle');
      if (reorderHandle) {
        const isManual = currentMemberSortMode === 'manual';
        reorderHandle.hidden = !isManual;
        reorderHandle.disabled = !isManual;
        reorderHandle.setAttribute('aria-hidden', String(!isManual));
        reorderHandle.tabIndex = isManual ? 0 : -1;
      }
      let skillRankBadge = card.querySelector('.member-skill-rank-badge');
      const skillRank = window.memberSkillRanks && window.memberSkillRanks[key];
      // Use an explicit class for responsive overlay placement.  This avoids
      // relying on :has() while the rank badge is being dynamically replaced.
      card.classList.toggle('has-skill-rank-badge', Boolean(skillRank));
      if (skillRank && !skillRankBadge) {
        skillRankBadge = document.createElement('span');
        skillRankBadge.className = 'member-skill-rank-badge';
        skillRankBadge.setAttribute('aria-label', 'ランキング ' + skillRank + '位');
        card.appendChild(skillRankBadge);
      }
      if (skillRankBadge) {
        skillRankBadge.hidden = !skillRank;
        skillRankBadge.dataset.rank = skillRank || '';
        const rankLabel = MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '';
        const rankValue = formatSkillRankValue(currentMemberSortMode, window.memberSkillRankValues && window.memberSkillRankValues[key], window.currentMembersData && window.currentMembersData[key]);
        skillRankBadge.setAttribute('aria-label', rankLabel + ' ' + (skillRank || '') + '位、' + rankValue);
        skillRankBadge.replaceChildren();
        if (skillRank) {
          const heading = document.createElement('span');
          heading.className = 'member-skill-rank-heading';
          const number = document.createElement('strong');
          number.textContent = String(skillRank);
          const label = document.createElement('small');
          label.textContent = rankLabel;
          heading.append(number, label);
          const valueLine = document.createElement('em');
          valueLine.textContent = rankValue;
          skillRankBadge.append(heading, valueLine);
        }
      }
      updateVsModeView();
      if (sharedListView) return;
      if (card.querySelector('.list-card-actions')) return;
      const actions = document.createElement('div');
      actions.className = 'list-card-actions';
      actions.innerHTML = '<button type="button">別リストへ移動</button><button type="button">別リストへ複製</button>';
      actions.children[0].onclick = () => transferMember(key, true);
      actions.children[1].onclick = () => transferMember(key, false);
      (card.querySelector('.card-admin-actions') || card).appendChild(actions);
    });
    requestAnimationFrame(syncMobileCardScale);
  }

  function transferMember(key, move) {
    const options = currentListEntries.filter(list => list.id !== activeListId);
    if (!options.length) return showToast('移動先のリストを先に作成してください');
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return showToast('対象プレイヤーを確認できません');

    pendingMemberTransfer = { key, move, sourceListId: activeListId };
    byId('memberTransferTitle').textContent = `別リストへ${move ? '移動' : '複製'}`;
    byId('memberTransferDescription').textContent =
      `「${member.name || member.gameId || 'このメンバー'}」の${move ? '移動' : '複製'}先を選んでください`;
    byId('memberTransferDestination').innerHTML = options.map(list =>
      `<option value="${escapeHtml(list.id)}">${escapeHtml(list.name)} · ${list.memberCount} players</option>`
    ).join('');
    byId('executeMemberTransferBtn').textContent = `このリストへ${move ? '移動' : '複製'}`;
    byId('memberTransferDialog').showModal();
    history.pushState({ ...(history.state || {}), kentomoOverlay: 'memberTransferDialog' }, '');
  }

  function closeMemberTransferDialog(fromHistory = false) {
    byId('memberTransferDialog')?.close();
    pendingMemberTransfer = null;
    if (!fromHistory && history.state?.kentomoOverlay === 'memberTransferDialog') history.back();
  }

  async function executeMemberTransfer() {
    const transfer = pendingMemberTransfer;
    const destinationId = byId('memberTransferDestination').value;
    const destination = currentListEntries.find(list => list.id === destinationId);
    if (!transfer || !destination || transfer.sourceListId !== activeListId) {
      closeMemberTransferDialog();
      return showToast('移動元または移動先のリストを確認できません');
    }
    const executeButton = byId('executeMemberTransferBtn');
    executeButton.disabled = true;
    executeButton.textContent = transfer.move ? '移動中...' : '複製中...';
    const { key, move } = transfer;
    try {
      const source = await membersRef.child(key).once('value');
      if (!source.exists()) {
        closeMemberTransferDialog();
        return showToast('対象プレイヤーが見つかりません');
      }
      const sourceMember = source.val();
      const destinationMembersRef = listsRef.child(destinationId).child('members');
      const destinationSnapshot = await destinationMembersRef.once('value');
      const normalizedSourceId = cleanTekkenId(sourceMember && sourceMember.gameId).toUpperCase();
      const duplicate = Object.values(destinationSnapshot.val() || {}).find(member =>
        cleanTekkenId(member && member.gameId).toUpperCase() === normalizedSourceId
      );
      if (duplicate) {
        const destinationName = destination.name;
        const duplicateName = duplicate.name || '登録済みプレイヤー';
        alert(move
          ? `「${destinationName}」には「${duplicateName}」が既にいるため、このメンバーを移動できません。\n移動先で同じTEKKEN 8 IDが重複する操作はできません。`
          : `「${destinationName}」には「${duplicateName}」が既にいるため、このメンバーを複製できません。\n複製先で同じTEKKEN 8 IDが重複する操作はできません。`);
        showToast(`別リストへの${move ? '移動' : '複製'}を中止しました`);
        return;
      }
      await destinationMembersRef.push(sourceMember);
      if (listIndexEnabled) {
        await listIndexRef.child(destinationId).child('memberCount').set(
          Object.keys(destinationSnapshot.val() || {}).length + 1
        );
      }
      if (move) await membersRef.child(key).remove();
      closeMemberTransferDialog();
      showToast(`「${destination.name}」へ${move ? '移動' : '複製'}しました`);
    } catch (error) {
      console.error('Member transfer failed', error);
      showToast(`${move ? '移動' : '複製'}に失敗しました: ${error.message || error}`);
    } finally {
      executeButton.disabled = false;
      if (pendingMemberTransfer) {
        executeButton.textContent = `このリストへ${move ? '移動' : '複製'}`;
      }
    }
  }

  async function startSharedListView(user, authSession, shareId) {
    const identity = `${user.uid}:shared:${shareId}`;
    if (activeWorkspaceIdentity && activeWorkspaceIdentity !== identity) teardownUserWorkspace();
    activeWorkspaceIdentity = identity;
    activeUser = user;
    setCurrentUserAdmin(false);
    hideGate();
    listsRef = db.ref(`users/${user.uid}/lists`);
    injectWorkspace();
    if (!user.isAnonymous) {
      try {
        const sharedAdminSnapshot = await db.ref(`admins/${user.uid}`).once('value');
        if (authSession === workspaceAuthSession && auth.currentUser?.uid === user.uid) {
          setCurrentUserAdmin(sharedAdminSnapshot.val() === true);
        }
      } catch (error) {
        console.warn('Shared view admin status check failed', error);
      }
    }
    bindSharedStatus();

    activeListId = `shared:${shareId}`;
    membersRef = null;
    settingsRef = null;
    listListenerRef = db.ref(`sharedLists/${shareId}`);
    settingsLogRef = null;
    memberSortRef = null;
    currentMemberSortMode = 'manual';
    currentMemberSortDirection = 'desc';
    excludeHistoricalFromSkillSort = false;
    window.privateListStorageScope = `shared_${shareId}`;
    const sharedSortSetting = readLocalMemberSort() || {};
    currentMemberSortMode = [
      'manual','name','rank','games','total_games','rating','winrate','power','last_active',
      'pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'
    ].includes(sharedSortSetting.mode) ? sharedSortSetting.mode : 'manual';
    currentMemberSortDirection = sharedSortSetting.direction === 'asc' ? 'asc' : 'desc';
    excludeHistoricalFromSkillSort = sharedSortSetting.excludeHistorical === true;
    window.memberAutoSortActive = currentMemberSortMode !== 'manual';
    window.currentMembersData = null;
    window.currentMembersLoaded = false;
    memberRenderSignature = '';
    latestAwardRun = null;
    latestAwardPeriod = '';
    updateAwardPlaybackButton();
    document.body.classList.add('shared-list-readonly');

    const select = byId('myListSelect');
    select.disabled = false;
    byId('workspaceAddMemberBtn').hidden = true;
    const sharedManualSortOption = byId('memberSortMode').querySelector('option[value="manual"]');
    if (sharedManualSortOption) sharedManualSortOption.textContent = '元の並び順';
    byId('listActionsSummary').title = '表示順設定';
    updateMemberSortControls();

    const banner = document.createElement('section');
    banner.id = 'sharedListViewBanner';
    banner.className = 'shared-list-view-banner';
    banner.innerHTML = `
      <div>
        <strong>閲覧専用の共有リスト</strong>
        <span>元のマイリストの変更が自動反映されます。表示順は「リスト設定」からこの端末だけで変更できます。</span>
      </div>
      <div class="shared-list-view-actions">
        <button type="button" id="favoriteSharedListBtn">☆ この共有リストをお気に入りに登録</button>
        <button type="button" id="importSharedListViewBtn">このリストを取り込む</button>
        <button type="button" id="returnToOwnListsBtn">自分のマイリストへ戻る</button>
      </div>
    `;
    byId('listWorkspace').insertAdjacentElement('afterend', banner);
    byId('favoriteSharedListBtn').onclick = toggleSharedListFavorite;
    byId('importSharedListViewBtn').onclick = importSharedListView;
    byId('returnToOwnListsBtn').onclick = returnToOwnLists;
    byId('loadingState').style.display = '';
    await new Promise((resolve, reject) => {
      let firstValue = true;
      listListenerRef.on('value', snapshot => {
        if (authSession !== workspaceAuthSession || auth.currentUser?.uid !== user.uid) return;
        const source = snapshot.val();
        if (!source || !source.name) {
          if (firstValue) reject(new Error('この共有リストは見つからないか、公開が終了しています。'));
          else gate('共有リストの公開が終了しました', '元のマイリストが削除されたか、共有が停止されました。', 'guest-error');
          firstValue = false;
          return;
        }
        const sharedMembers = sanitizeSharedMembers(source.members);
        const nextMemberRenderSignature = createMemberRenderSignature(sharedMembers);
        const isStatsOnlyUpdate = Boolean(memberRenderSignature)
          && nextMemberRenderSignature === memberRenderSignature;
        sharedListView = {
          id: shareId,
          name: safeName(source.name) || '共有リスト',
          members: sharedMembers,
          awardResult: source.awardResult || null
        };
        if (source.awardResult?.results?.categories) {
          latestAwardPeriod = String(source.awardResult.period || '前月');
          latestAwardRun = { results: source.awardResult.results };
        } else {
          latestAwardPeriod = '';
          latestAwardRun = null;
        }
        updateAwardPlaybackButton();
        window.currentMembersData = sharedListView.members;
        window.currentMembersLoaded = true;
        byId('loadingState').style.display = 'none';
        applyActiveListName(`${sharedListView.name}（閲覧専用）`);
        applySharedListDocumentTitle(sharedListView.name);
        refreshSharedFavoriteNavigation().catch(error => console.warn('Shared favorite navigation failed', error));
        if (isStatsOnlyUpdate) {
          patchVisibleAutoNames(sharedListView.members);
          window.refreshVisibleStats?.();
          if (window.memberAutoSortActive) {
            requestAnimationFrame(() => {
              const grid = byId('posterGrid');
              if (!grid || window.cardReorderInProgress) return;
              const manualEntries = Object.entries(sharedListView.members)
                .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
              const sortedEntries = typeof window.sortMemberEntries === 'function'
                ? window.sortMemberEntries(manualEntries)
                : manualEntries;
              const cards = new Map([...grid.querySelectorAll(':scope > .poster-card')]
                .map(card => [card.dataset.memberKey, card]));
              const fragment = document.createDocumentFragment();
              sortedEntries.forEach(([key]) => {
                const card = cards.get(key);
                if (card) fragment.appendChild(card);
              });
              grid.appendChild(fragment);
            });
          }
        } else {
          memberRenderSignature = nextMemberRenderSignature;
          renderPosters(sharedListView.members);
          setTimeout(addPerCardListActions, 0);
        }
        if (firstValue) resolve();
        firstValue = false;
      }, error => {
        if (firstValue) reject(error);
        else console.warn('Shared list live update failed', error);
        firstValue = false;
      });
    });
    trackSharedListVisit(shareId);
  }

  async function startUserWorkspace(user, authSession) {
    const identity = `${user.uid}:${user.isAnonymous ? 'guest' : 'google'}`;
    if (activeWorkspaceIdentity && activeWorkspaceIdentity !== identity) teardownUserWorkspace();
    activeWorkspaceIdentity = identity;
    activeUser = user;
    setCurrentUserAdmin(false);
    hideGate();
    await db.ref(`users/${user.uid}/profile`).update({
      displayName: user.displayName || '', email: user.email || '',
      photoURL: user.photoURL || '', lastLoginAt: firebase.database.ServerValue.TIMESTAMP
    });
    if (authSession !== workspaceAuthSession || auth.currentUser?.uid !== user.uid) return;
    if (!user.isAnonymous) {
      db.ref(`accountUsers/${user.uid}`).update({
        displayName: user.displayName || '',
        email: user.email || '',
        lastLoginAt: firebase.database.ServerValue.TIMESTAMP
      }).catch(error => console.warn('Google account registration log failed', error));
    }
    listsRef = db.ref(`users/${user.uid}/lists`);
    injectWorkspace();
    const adminSnapshot = await db.ref(`admins/${user.uid}`).once('value');
    if (authSession !== workspaceAuthSession || auth.currentUser?.uid !== user.uid) return;
    if (adminSnapshot.val() === true && byId('adminPanelBtn')) {
      setCurrentUserAdmin(true);
      byId('adminToolsToggleBtn').hidden = false;
      byId('adminPanelBtn').hidden = false;
      if (byId('adminCacheResetBtn')) byId('adminCacheResetBtn').hidden = false;
      if (byId('adminLocalCacheClearBtn')) byId('adminLocalCacheClearBtn').hidden = false;
      byId('adminPanelBtn').onclick = () => window.startAdminAccessPanel(user, db, auth);
    }
    bindSharedStatus();
    subscribeLists();
    setupDragAndDrop();
  }

  window.init = function initPrivateListsPrototype() {
    const savedTheme = localStorage.getItem('preferred_theme');
    if (['wanted', 'modern', 'japanese'].includes(savedTheme)) currentTheme = savedTheme;
    byId('themeSelectDropdown').value = currentTheme;
    applyTheme(currentTheme);
    installMobileLandscapeGuard();
    installPortraitOrientationGuard();
    lockPortraitOrientation();
    if (!/^https?:$/.test(location.protocol)) {
      gate('起動方法を変更してください', 'このページは file:// ではGoogleログインを利用できません。同じフォルダーの start-user-lists-prototype.cmd を実行してください。', 'login');
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    auth = firebase.auth();
    gate('拳トモくん（仮） / BFF-kun（β）', 'ゲスト用マイリストを準備しています。', 'loading');
    let anonymousSignInStarted = false;
    auth.onAuthStateChanged(user => {
      const authSession = ++workspaceAuthSession;
      if (!user) {
        teardownUserWorkspace();
        activeUser = null;
        activeWorkspaceIdentity = '';
        setCurrentUserAdmin(false);
        gate('拳トモくん（仮） / BFF-kun（β）', 'ゲスト用マイリストを準備しています。', 'loading');
        if (!anonymousSignInStarted) {
          anonymousSignInStarted = true;
          auth.signInAnonymously().catch(error => {
            anonymousSignInStarted = false;
            const detail = error && error.code === 'auth/operation-not-allowed'
              ? 'Firebase Authenticationで「匿名」ログインを有効にしてください。'
              : (error.message || String(error));
            gate('ゲストモードを開始できませんでした', detail, 'guest-error');
          });
        }
        return;
      }
      anonymousSignInStarted = false;
      const shareId = sharedListIdFromUrl();
      if (shareId) {
        startSharedListView(user, authSession, shareId)
          .catch(error => gate('共有リストを開けませんでした', error.message || String(error), 'guest-error'));
        return;
      }
      if (sessionStorage.getItem('t8_admin_mode') === '1') {
        sessionStorage.removeItem('t8_admin_mode');
        startUserWorkspace(user, authSession)
          .catch(error => gate('管理者ログインエラー', error.message, 'guest-error'));
        return;
      }
      startUserWorkspace(user, authSession).catch(error => gate('接続エラー', error.message, 'pending'));
    });
  };

  const closeLastSeenScopeTips = except => {
    document.querySelectorAll('.last-seen-badge.scope-open').forEach(badge => {
      if (badge !== except) badge.classList.remove('scope-open');
    });
  };

  document.addEventListener('pointerdown', event => {
    if (event.target.closest('.last-seen-badge[data-last-seen-scope]')) event.stopPropagation();
  });

  document.addEventListener('click', event => {
    const badge = event.target.closest('.last-seen-badge[data-last-seen-scope]');
    const isTouchLayout = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    if (!badge || !isTouchLayout) {
      closeLastSeenScopeTips();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const shouldOpen = !badge.classList.contains('scope-open');
    closeLastSeenScopeTips(badge);
    badge.classList.toggle('scope-open', shouldOpen);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLastSeenScopeTips();
  });
  window.saveTitle = function saveActiveListTitle() {
    const input = byId('titleInput');
    const name = safeName(input.value);
    const previousName = byId('titleText').textContent;
    const editedListId = activeListId;
    input.onblur = null;
    input.style.display = 'none';
    byId('pageTitle').style.display = '';
    if (name && settingsRef) {
      applyActiveListName(name);
      settingsRef.child('name').set(name)
        .then(() => {
          if (activeListId === editedListId) applyActiveListName(name);
          showToast('リスト名を変更しました');
        })
        .catch(error => {
          if (activeListId === editedListId) applyActiveListName(previousName);
          showToast(`名前変更に失敗しました: ${error.message}`);
        });
    } else {
      applyActiveListName(previousName || 'マイリスト');
    }
  };

  // Full profiles are normally supplied by the Worker. An owned-list open can
  // make one guarded sequential refresh pass; latest-battle remains separate.
  const latestBattleFetchTimes = new Map();
  const latestBattleFailureAttempts = new Map();
  const LATEST_BATTLE_FETCH_INTERVAL_MS = 5 * 60 * 1000;
  const LATEST_BATTLE_RENDER_INTERVAL_MS = 60 * 1000;
  let latestBattleRefreshRunning = false;
  let latestBattleRefreshTimer = null;
  const autoNameSyncInFlight = new Set();
  const noteLatestBattleFailure = gameId => {
    const failures = Math.min((latestBattleFailureAttempts.get(gameId) || 0) + 1, 3);
    latestBattleFailureAttempts.set(gameId, failures);
    return [30000, 90000, 5 * 60 * 1000][failures - 1];
  };
  const clearLatestBattleFailure = gameId => latestBattleFailureAttempts.delete(gameId);

  const syncAutomaticPlayerName = (key, member, playerName, playerNameSource = '') => {
    const nextName = String(playerName || '').trim().slice(0, 50);
    if (!member) return;
    const gameId = cleanTekkenId(member.gameId);
    const isIdPlaceholder = Boolean(gameId)
      && cleanTekkenId(member.name).toUpperCase() === gameId.toUpperCase();
    if (
      !nextName
      || /^Just a moment|^Wavu Wank$/i.test(nextName)
      || cleanTekkenId(nextName).toUpperCase() === gameId.toUpperCase()
    ) return;
    const currentMember = window.currentMembersData && window.currentMembersData[key];
    const currentIsIdPlaceholder = currentMember && Boolean(gameId)
      && cleanTekkenId(currentMember.name).toUpperCase() === gameId.toUpperCase();
    if (!membersRef || !currentMember) return;
    if (!gameId || cleanTekkenId(currentMember.gameId).toUpperCase() !== gameId.toUpperCase() || autoNameSyncInFlight.has(key)) return;
    const updatePrimaryName = currentMember.nameMode === 'auto' || currentIsIdPlaceholder;
    if (nextName === currentMember.autoName && (!updatePrimaryName || nextName === currentMember.name)) return;

    const nextSource = /^ewgf-/i.test(String(playerNameSource || ''))
      ? String(playerNameSource).slice(0, 40)
      : 'wavu-profile';
    autoNameSyncInFlight.add(key);
    currentMember.autoName = nextName;
    currentMember.autoNameUpdatedAt = Date.now();
    if (updatePrimaryName) {
      currentMember.name = nextName;
      currentMember.nameMode = 'auto';
      currentMember.nameSource = nextSource;
    }
    const card = document.querySelector(`.poster-card[data-member-key="${CSS.escape(key)}"]`);
    const nameElement = card && card.querySelector('.poster-name-text');
    if (nameElement && updatePrimaryName) nameElement.textContent = nextName;
    let trackedElement = card && card.querySelector('.poster-name-tracked');
    if (!updatePrimaryName && nextName) {
      if (!trackedElement) {
        trackedElement = document.createElement('span');
        trackedElement.className = 'poster-name-tracked';
        card.querySelector('.poster-name')?.append(trackedElement);
      }
      card.querySelector('.poster-name')?.classList.add('has-tracked-name');
      trackedElement.textContent = nextName;
      trackedElement.title = `自動取得名：${nextName}`;
    } else if (trackedElement) {
      trackedElement.remove();
      card.querySelector('.poster-name')?.classList.remove('has-tracked-name');
    }

    const updates = {
      autoName: nextName,
      autoNameUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    };
    if (updatePrimaryName) Object.assign(updates, {
      name: nextName,
      nameMode: 'auto',
      nameSource: nextSource
    });
    const saveNameUpdates = typeof window.syncPlayerNameAcrossLists === 'function'
      ? window.syncPlayerNameAcrossLists(gameId, updates).then(matched =>
        matched || membersRef.child(key).update(updates)
      )
      : membersRef.child(key).update(updates);
    saveNameUpdates.catch(error => {
      console.warn('Automatic player name sync failed', gameId, error);
    }).finally(() => autoNameSyncInFlight.delete(key));
  };

  const updateLatestBattleCard = (key, member, payload) => {
    const gameId = typeof cleanTekkenId === 'function'
      ? cleanTekkenId(member && member.gameId)
      : String(member && member.gameId || '').replace(/-/g, '');
    if (!gameId) return;
    if (payload && payload.playerName) {
      syncAutomaticPlayerName(key, member, payload.playerName, payload.playerNameSource);
    }
    const storageKey = `t8_wanted_ewgf_stats_v3_${gameId}`;
    let stats = {};
    try { stats = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; }
    catch (_) {}
    let battle = payload && payload.latestBattle;
    if (battle) {
      const selectedAt = Date.parse(battle.at || '');
      const hasUsefulType = value => Boolean(value) && !/^(?:種別不明|unknown)$/i.test(String(value).trim());
      const matchingDetails = Array.isArray(payload.latestCandidates)
        ? payload.latestCandidates.find(candidate =>
          Number.isFinite(selectedAt)
          && Math.abs(Date.parse(candidate.at || '') - selectedAt) <= 1000
          && (hasUsefulType(candidate.battleType) || candidate.character)
        )
        : null;
      if (matchingDetails) {
        battle = {
          ...battle,
          battleType: hasUsefulType(battle.battleType) ? battle.battleType : (matchingDetails.battleType || ''),
          character: battle.character || matchingDetails.character || ''
        };
      }
    }
    const parsedAt = Date.parse(battle && battle.at || payload && payload.latestBattleAt || '');
    const previousAt = Number(stats.lastSeenTimestamp || 0);
    const incomingIsCurrent = Number.isFinite(parsedAt) && parsedAt >= previousAt;
    if (incomingIsCurrent) {
      stats.lastSeenTimestamp = parsedAt;
      // Equal timestamps may be a corrected classification of the same battle.
      // Prefer the Worker's all-battle-type details over stale Firebase labels.
      if (battle && battle.character) stats.latestBattleCharacter = battle.character;
      if (battle && battle.battleType && !/^(?:種別不明|unknown)$/i.test(String(battle.battleType).trim())) {
        stats.latestBattleType = battle.battleType;
      }
    }
    const checkedAt = Date.now();
    stats.latestBattleCheckedAt = checkedAt;
    stats.latestBattleRevisionAt = checkedAt;
    // Do not advance stats.cachedAt here. That timestamp controls the separate
    // 12-hour Wavu qualification/rating refresh.
    try { localStorage.setItem(storageKey, JSON.stringify(stats)); } catch (_) {}
    const card = document.querySelector(`.poster-card[data-member-key="${CSS.escape(key)}"]`);
    const wrapper = card && card.querySelector('.last-seen-badge-wrapper');
    if (wrapper && typeof getLastSeenBadgeHtml === 'function') {
      wrapper.innerHTML = getLastSeenBadgeHtml(stats.lastSeenTimestamp, stats);
    }
  };

  async function refreshNewMemberLatestBattle(key, member) {
    const gameId = typeof cleanTekkenId === 'function'
      ? cleanTekkenId(member && member.gameId)
      : String(member && member.gameId || '').replace(/-/g, '');
    if (!key || !gameId) return false;

    // A newly published card should not wait for the periodic latest-battle pass.
    // Prefer the shared short-lived cache first. A cache miss can still populate
    // it, so only the final attempt bypasses the cache and reaches the origin.
    const attempts = [
      { force: false, delay: 0 },
      { force: false, delay: 1200 },
      { force: true, delay: 2800 }
    ];
    for (const attempt of attempts) {
      if (attempt.delay) await new Promise(resolve => setTimeout(resolve, attempt.delay));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(
          `https://tight-bar-55c1.uracil123.workers.dev/?ewgfId=${encodeURIComponent(gameId)}&mode=latest${attempt.force ? '&force=1' : ''}`,
          { cache: 'no-store', signal: controller.signal }
        );
        if (!response.ok) throw new Error(`Latest battle HTTP ${response.status}`);
        const payload = await response.json();
        updateLatestBattleCard(key, member, payload);
        if (!payload.latestBattle) throw new Error('Latest battle payload is unavailable');
        latestBattleFetchTimes.set(gameId, Date.now());
        clearLatestBattleFailure(gameId);

        // Share the fresh result with the account/list so another device does
        // not have to wait for its own periodic refresh.
        const storageKey = `t8_wanted_ewgf_stats_v3_${gameId}`;
        let latestStats = null;
        try { latestStats = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
        catch (_) {}
        if (latestStats && membersRef) {
          await membersRef.child(key).child('fetchedStats').child('activityStats').update({
            lastSeenTimestamp: latestStats.lastSeenTimestamp || null,
            latestBattleCharacter: latestStats.latestBattleCharacter || '',
            latestBattleType: latestStats.latestBattleType || '',
            latestBattleCheckedAt: latestStats.latestBattleCheckedAt || Date.now(),
            latestBattleRevisionAt: latestStats.latestBattleRevisionAt || Date.now()
          });
        }
        return true;
      } catch (error) {
        console.warn('New member latest battle preparation failed', gameId, error);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return false;
  }
  window.refreshNewMemberLatestBattle = refreshNewMemberLatestBattle;

  async function refreshVisibleLatestBattles(force = false, missingNamesOnly = false) {
    if (latestBattleRefreshRunning || !window.currentMembersData) return;
    latestBattleRefreshRunning = true;
    try {
      const now = Date.now();
      let earliestRetryDelay = 0;
      for (const [key, member] of Object.entries(window.currentMembersData)) {
        if (missingNamesOnly && String(member?.autoName || '').trim()) continue;
        const gameId = typeof cleanTekkenId === 'function'
          ? cleanTekkenId(member && member.gameId)
          : String(member && member.gameId || '').replace(/-/g, '');
        if (!gameId) continue;
        const lastFetch = latestBattleFetchTimes.get(gameId) || 0;
        if (!force && now - lastFetch < LATEST_BATTLE_FETCH_INTERVAL_MS) {
          updateLatestBattleCard(key, member, null);
          continue;
        }
        let receivedLatestBattle = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await fetch(
              `https://tight-bar-55c1.uracil123.workers.dev/?ewgfId=${encodeURIComponent(gameId)}&mode=latest${force ? '&force=1' : ''}`,
              { cache: 'no-store', signal: controller.signal }
            );
            if (response.ok) {
              const payload = await response.json();
              // An older Worker ignores mode=latest and returns the 12-hour
              // profile cache. Never let that response roll the visible time back.
              if (Number(payload.workerCacheTtlSeconds) <= 300 && (payload.latestBattle || payload.playerName)) {
                updateLatestBattleCard(key, member, payload);
                if (payload.latestBattle) {
                  latestBattleFetchTimes.set(gameId, Date.now());
                  clearLatestBattleFailure(gameId);
                  receivedLatestBattle = true;
                }
              } else {
                console.warn('Latest battle Worker is not deployed yet; ignored stale profile response', gameId);
              }
              if (receivedLatestBattle) break;
              if (attempt === 0) {
                await new Promise(resolve => setTimeout(resolve, 1800 + Math.floor(Math.random() * 1400)));
                continue;
              }
              break;
            }
            const retryable = [502, 503, 504, 522, 524].includes(response.status);
            if (attempt === 0 && retryable && !force) {
              await new Promise(resolve => setTimeout(resolve, 2000 + Math.floor(Math.random() * 3000)));
              continue;
            }
            console.warn('Latest battle refresh HTTP error', gameId, response.status);
            break;
          } catch (error) {
            if (attempt === 0 && !force) {
              await new Promise(resolve => setTimeout(resolve, 2000 + Math.floor(Math.random() * 3000)));
              continue;
            }
            console.warn('Latest battle refresh failed', gameId, error);
          } finally {
            clearTimeout(timeoutId);
          }
        }
        if (!receivedLatestBattle) {
          const retryDelay = noteLatestBattleFailure(gameId);
          earliestRetryDelay = !earliestRetryDelay ? retryDelay : Math.min(earliestRetryDelay, retryDelay);
        }
        // Avoid a burst when opening a large list.
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (earliestRetryDelay) scheduleLatestBattleRefresh(earliestRetryDelay, true);
    } finally {
      latestBattleRefreshRunning = false;
    }
  }

  // Refresh the lightweight latest-battle endpoint immediately on list open,
  // then at most once per five minutes while the list remains open. This never
  // triggers the heavier profile / rating acquisition pipeline.
  const initialLatestBattleReadyAt = Date.now();
  const PAGE_OPEN_LATEST_BATTLE_REFRESH_ENABLED = true;
  const scheduleLatestBattleRefresh = (delay = 250, bypassInitialDelay = false, missingNamesOnly = false) => {
    if (!PAGE_OPEN_LATEST_BATTLE_REFRESH_ENABLED) return;
    if (!bypassInitialDelay) {
      delay = Math.max(delay, initialLatestBattleReadyAt - Date.now());
    }
    clearTimeout(latestBattleRefreshTimer);
    latestBattleRefreshTimer = setTimeout(
      () => refreshVisibleLatestBattles(false, missingNamesOnly),
      delay
    );
  };

  const posterGrid = byId('posterGrid');
  if (posterGrid) {
    new MutationObserver(() => scheduleLatestBattleRefresh())
      .observe(posterGrid, { childList: true });
  }
  setInterval(() => scheduleLatestBattleRefresh(0), LATEST_BATTLE_RENDER_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleLatestBattleRefresh(0);
  });
  window.addEventListener('focus', () => scheduleLatestBattleRefresh(0));
  window.addEventListener('online', () => {
    latestBattleFetchTimes.clear();
    scheduleLatestBattleRefresh(0);
  });
  scheduleLatestBattleRefresh(90 * 1000);

  // Opening an owned list refreshes its full profile data in a slow, visible
  // sweep. Keep it distinct from the five-minute latest-battle polling above:
  // a quick series of list switches must never fan out into several full runs.
  const PAGE_OPEN_PROFILE_LIST_COOLDOWN_MS = 30 * 60 * 1000;
  const PAGE_OPEN_PROFILE_GLOBAL_COOLDOWN_MS = 2 * 60 * 1000;
  // The server sweep is a 12-hour safety net. An actively opened list should
  // feel fresher, so only profiles updated within the last three hours skip
  // the on-open sequential pass.
  const PAGE_OPEN_PROFILE_FRESHNESS_MS = 3 * 60 * 60 * 1000;
  const PAGE_OPEN_PROFILE_SETTLE_MS = 1800;
  const PAGE_OPEN_PROFILE_GAP_MS = 900;
  let pageOpenProfileRunSerial = 0;
  let pageOpenProfileTimer = null;
  let pageOpenProfileStartedAt = 0;
  let pageOpenProfileActive = false;

  const pageOpenProfileStorageKey = listId => {
    const uid = String(activeUser?.uid || 'guest');
    return `kentomo_page_open_profile_refresh_${uid}_${listId}`;
  };
  const readPageOpenProfileStartedAt = listId => {
    try { return Number(localStorage.getItem(pageOpenProfileStorageKey(listId)) || 0); }
    catch (_) { return 0; }
  };
  const writePageOpenProfileStartedAt = (listId, timestamp) => {
    try { localStorage.setItem(pageOpenProfileStorageKey(listId), String(timestamp)); }
    catch (_) {}
  };
  const profileSnapshotTimestamp = member => {
    const stats = memberStats(member || {});
    const meta = stats.fetchMeta || member?.fetchedStats?.fetchMeta || {};
    const candidates = [meta.completedAt, meta.updatedAt, stats.updatedAt, member?.fetchedStats?.updatedAt]
      .map(value => typeof value === 'string' ? Date.parse(value) : Number(value))
      .filter(value => Number.isFinite(value) && value > 0);
    return candidates.length ? Math.max(...candidates) : 0;
  };
  const hasFreshProfileSnapshot = (member, now = Date.now()) => {
    const timestamp = profileSnapshotTimestamp(member);
    return timestamp > 0 && now - timestamp >= 0 && now - timestamp < PAGE_OPEN_PROFILE_FRESHNESS_MS;
  };

  function scheduleOwnedListProfileRefresh(listId, members) {
    if (!listId || !members || !Object.keys(members).length || !activeUser || sharedListView) return;
    const now = Date.now();
    if (now - readPageOpenProfileStartedAt(listId) < PAGE_OPEN_PROFILE_LIST_COOLDOWN_MS) return;
    const runSerial = ++pageOpenProfileRunSerial;
    clearTimeout(pageOpenProfileTimer);
    const earliestStart = pageOpenProfileStartedAt + PAGE_OPEN_PROFILE_GLOBAL_COOLDOWN_MS;
    const delay = Math.max(PAGE_OPEN_PROFILE_SETTLE_MS, earliestStart - now, 0);
    pageOpenProfileTimer = setTimeout(() => runOwnedListProfileRefresh(listId, members, runSerial), delay);
  }

  async function runOwnedListProfileRefresh(listId, members, runSerial) {
    if (runSerial !== pageOpenProfileRunSerial || activeListId !== listId || sharedListView) return;
    if (pageOpenProfileActive || !window.kentomoStatsIntegrationReady) {
      pageOpenProfileTimer = setTimeout(
        () => runOwnedListProfileRefresh(listId, members, runSerial),
        1200
      );
      return;
    }
    const now = Date.now();
    if (now - readPageOpenProfileStartedAt(listId) < PAGE_OPEN_PROFILE_LIST_COOLDOWN_MS) return;
    const uniquePlayers = new Map();
    for (const [key, member] of Object.entries(members)) {
      const gameId = cleanTekkenId(member?.gameId);
      if (gameId && !uniquePlayers.has(gameId.toUpperCase())) uniquePlayers.set(gameId.toUpperCase(), { key, member, gameId });
    }
    const stalePlayers = [...uniquePlayers.values()]
      .filter(({ member }) => !hasFreshProfileSnapshot(member, now));
    if (!stalePlayers.length) return;

    pageOpenProfileActive = true;
    pageOpenProfileStartedAt = now;
    showToast(`↻ このリストの未更新データを順次更新中（${stalePlayers.length}/${uniquePlayers.size}人）`);
    let completed = 0;
    let skipped = 0;
    try {
      for (const { key, member, gameId } of stalePlayers) {
        // A new list selection invalidates this sweep after the current member.
        if (runSerial !== pageOpenProfileRunSerial || activeListId !== listId || sharedListView) break;
        window.kentomoPageOpenProfileRefresh = true;
        try {
          // Use the same card updater as the explicit refresh button. Besides
          // storing the profile it updates every visible field, including the
          // independent lifetime all-match row.
          const stats = typeof window.refreshCardStats === 'function'
            ? await window.refreshCardStats(gameId, key, { silent: true, isManual: false })
            : await fetchEwgfStats(gameId, true, key, false, member.name || '');
          if (stats?.isError || stats?.refreshFailed || stats?.refreshUsedSharedCache) skipped += 1;
          else completed += 1;
          window.refreshVisibleStats?.();
        } catch (error) {
          skipped += 1;
          console.warn('List-open profile refresh failed', gameId, error);
        } finally {
          window.kentomoPageOpenProfileRefresh = false;
        }
        if (runSerial === pageOpenProfileRunSerial && activeListId === listId) {
          showToast(`↻ リストを順次更新中… ${completed + skipped}/${stalePlayers.length}人`);
          await new Promise(resolve => setTimeout(resolve, PAGE_OPEN_PROFILE_GAP_MS));
        }
      }
      if (runSerial === pageOpenProfileRunSerial && activeListId === listId) {
        // Only a run that obtained at least one usable profile should suppress
        // another list-open attempt. A transient all-failure remains retryable.
        if (completed > 0) writePageOpenProfileStartedAt(listId, now);
        showToast(skipped
          ? `↻ リスト更新完了：${completed}人を更新、${skipped}人は保存データを使用`
          : `↻ リスト更新完了：${completed}人を更新しました`);
      }
    } finally {
      window.kentomoPageOpenProfileRefresh = false;
      pageOpenProfileActive = false;
    }
  }

  function adminClearLocalStatsCache(askForConfirmation = false) {
    if (askForConfirmation && !confirm(
      'このブラウザに保存された拳トモくんの統計キャッシュを全削除して再読み込みします。\n' +
      'マイリスト・メンバー・表示設定・ログイン状態は削除されません。実行しますか？'
    )) return 0;
    const targets = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('t8_wanted_ewgf_stats_v3_')) targets.push(key);
    }
    targets.forEach(key => localStorage.removeItem(key));
    latestBattleFetchTimes.clear();
    exportAssetDataUrlCache.clear();
    exportAssetBlobCache.clear();
    showToast(`この端末の統計キャッシュを${targets.length}件削除しました。再読み込みします…`);
    setTimeout(() => location.reload(), 450);
    return targets.length;
  }
  window.adminClearLocalStatsCache = () => adminClearLocalStatsCache(false);

  const refreshCurrentCardsInPlace = () => {
    if (!window.currentMembersData) return;
    patchVisibleAutoNames(window.currentMembersData);
    window.refreshVisibleStats?.();
  };

  async function adminResetCurrentListCache() {
    const members = window.currentMembersData || {};
    const entries = Object.entries(members);
    if (!entries.length) return showToast('このリストにはメンバーがいません');
    const confirmed = confirm(
      `管理者操作：このリストの${entries.length}人について、EWGF・Wavuから強制再取得します。\n` +
      '取得に失敗した選手は現在の正常データを保持します。通常更新より通信量が多く、完了まで時間がかかります。実行しますか？'
    );
    if (!confirmed) return;
    const button = byId('adminCacheResetBtn');
    if (button) button.disabled = true;
    showToast(`管理者更新：${entries.length}人を安全に順次更新します…`);
    try {
      latestBattleFetchTimes.clear();
      window.forceAdminProfileRefresh = true;
      let completed = 0;
      let retained = 0;
      const failures = [];
      for (const [key, member] of entries) {
        const gameId = cleanTekkenId(member && member.gameId);
        if (!gameId) continue;
        const stats = await refreshCardStats(gameId, key);
        if (stats && (stats.refreshFailed || stats.isError)) {
          retained += 1;
          failures.push(`${member.name || gameId}: ${stats.refreshErrorStatus ? `HTTP ${stats.refreshErrorStatus}` : ''} ${stats.refreshErrorMessage || '取得失敗'}`.trim());
        } else if (stats && stats.refreshUsedSharedCache) retained += 1;
        else completed += 1;
        showToast(`管理者更新：${completed + retained}/${entries.length}人を処理中…`);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      window.forceAdminProfileRefresh = false;
      // Latest-battle route already refreshes every five minutes. Reuse its
      // shared cache here instead of adding another forced burst for the list.
      await refreshVisibleLatestBattles(false);
      refreshCurrentCardsInPlace();
      showToast(retained
        ? `管理者更新：${completed}人を最新化、${retained}人は安全な保存データを表示`
        : `管理者更新：${completed}人の最新データを再取得しました`);
      if (failures.length) {
        alert(`取得できなかったプレイヤー（既存データは保持）\n\n${failures.join('\n')}`);
      }
    } catch (error) {
      window.forceAdminProfileRefresh = false;
      console.error('Admin cache reset failed', error);
      alert(`キャッシュ完全更新に失敗しました: ${error.message || error}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function refreshSingleMemberStats(key) {
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return showToast('対象プレイヤーを確認できません');
    const gameId = cleanTekkenId(member.gameId);
    if (!gameId) return showToast('TEKKEN 8 IDを確認できません');
    const isAdminRefresh = Boolean(window.isCurrentUserAdmin);
    if (!confirm(
      `${isAdminRefresh ? '管理者操作：' : ''}「${member.name || gameId}」だけをEWGF・Wavuから再取得します。\n` +
      '取得に失敗した場合、現在表示しているデータは削除しません。実行しますか？'
    )) return;
    const button = document.querySelector(`[data-refresh-member="${CSS.escape(key)}"]`);
    if (button) {
      button.disabled = true;
      button.textContent = '↻ 取得中';
    }
    try {
      // 管理者だけ上流を強制更新する。ゲストを含む通常ユーザーはWorker共有キャッシュを使う。
      window.forceAdminProfileRefresh = isAdminRefresh;
      const stats = await refreshCardStats(gameId, key);
      window.forceAdminProfileRefresh = false;
      latestBattleFetchTimes.delete(gameId);
      scheduleLatestBattleRefresh(250, true);
      if (stats && (stats.refreshFailed || stats.isError)) {
        const status = stats.refreshErrorStatus ? `HTTP ${stats.refreshErrorStatus}` : '通信エラー';
        alert(`「${member.name || gameId}」の再取得に失敗しました（${status}）。\n現在の正常データがある場合は保持しています。\n${stats.refreshErrorMessage || '時間を置いてもう一度お試しください。'}`);
      } else if (stats && stats.refreshUsedSharedCache) {
        showToast(`「${member.name || gameId}」は安全な共有キャッシュから復旧しました`);
      } else {
        showToast(`「${member.name || gameId}」を個別更新しました`);
        refreshCurrentCardsInPlace();
      }
    } catch (error) {
      console.error('Single member refresh failed', error);
      alert(`個別データ再取得に失敗しました。現在の表示データは保持しています。\n${error.message || error}`);
    } finally {
      window.forceAdminProfileRefresh = false;
      if (button) {
        button.disabled = false;
        button.textContent = '↻ 再取得';
      }
    }
  }
  window.refreshSingleMemberStats = refreshSingleMemberStats;

  async function retryFailedMemberStats(key) {
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return showToast('対象プレイヤーを確認できません');
    const gameId = cleanTekkenId(member.gameId);
    const button = document.querySelector(`[data-retry-member="${CSS.escape(key)}"]`);
    if (!gameId || !button || button.disabled) return;
    button.disabled = true;
    button.textContent = '↻ 再試行中';
    try {
      // 一般ユーザーの復旧はforce=1を使わず、Worker共有キャッシュを優先する。
      window.forceAdminProfileRefresh = false;
      const stats = await fetchEwgfStats(gameId, false, key, true, member.name || '');
      if (!stats || stats.isError || stats.refreshFailed) {
        button.classList.add('is-visible');
        const status = stats?.refreshErrorStatus ? `HTTP ${stats.refreshErrorStatus}` : '通信混雑';
        showToast(`⚠️ 再試行失敗（${status}）。少し時間を置いてください`);
        return;
      }
      button.classList.remove('is-visible');
      showToast(`「${member.name || gameId}」の表示を復旧しました`);
      refreshCurrentCardsInPlace();
      latestBattleFetchTimes.delete(gameId);
      scheduleLatestBattleRefresh(250, true);
    } catch (error) {
      button.classList.add('is-visible');
      showToast(`⚠️ 再試行失敗：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '↻ 再試行';
    }
  }
  window.retryFailedMemberStats = retryFailedMemberStats;
})();





















