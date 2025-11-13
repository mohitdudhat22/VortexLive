  export function showLoadingState(message = 'Starting stream...') {
    // if already exists, update text
    let loadingElem = document.getElementById('stream-loading');
    if (!loadingElem) {
      loadingElem = document.createElement('div');
      loadingElem.id = 'stream-loading';
      loadingElem.style.position = 'fixed';
      loadingElem.style.top = '0';
      loadingElem.style.left = '0';
      loadingElem.style.right = '0';
      loadingElem.style.bottom = '0';
      loadingElem.style.backgroundColor = 'rgba(0,0,0,0.7)';
      loadingElem.style.display = 'flex';
      loadingElem.style.alignItems = 'center';
      loadingElem.style.justifyContent = 'center';
      loadingElem.style.zIndex = '9999';
      loadingElem.innerHTML = `<div style="color:white;text-align:center;">
                                <div style="display:inline-block;width:40px;height:40px;border:3px solid #fff;border-radius:50%;border-top-color:transparent;animation:spin 1s linear infinite;"></div>
                                <div style="margin-top:10px;" id="stream-loading-text">${message}</div>
                              </div>`;
      document.body.appendChild(loadingElem);

      const style = document.createElement('style');
      style.id = 'stream-loading-style';
      style.innerHTML = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
      document.head.appendChild(style);
    } else {
      const txt = document.getElementById('stream-loading-text');
      if (txt) txt.textContent = message;
    }
  }

  export function hideLoadingState() {
    const loadingElem = document.getElementById('stream-loading');
    if (loadingElem) loadingElem.remove();
    const style = document.getElementById('stream-loading-style');
    if (style) style.remove();
  }