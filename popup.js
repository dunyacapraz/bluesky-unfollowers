document.addEventListener('DOMContentLoaded', async () => {
  const state = {
    currentUserDid: null,
    followsCache: new Map(),
    followersCache: new Map(),
    profilesCache: new Map(),
    lastRequestTime: 0
  };


  async function checkExistingSession() {
    const savedToken = localStorage.getItem('accessToken');
    if (!savedToken) return false;

    try {
      await rateLimit();
      const response = await fetch('https://bsky.social/xrpc/app.bsky.actor.getProfile', {
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      
      if (!response.ok) throw new Error('Invalid token');
      
      const profile = await response.json();
      state.currentUserDid = profile.did;
      
      // UI güncellemeleri
      document.getElementById('loginForm').classList.add('hidden');
      document.getElementById('logoutBtn').classList.remove('hidden');
      document.getElementById('handle').value = profile.handle;
      
      return true;
    } catch (error) {
      localStorage.removeItem('accessToken');
      return false;
    }
  }

 
  const hasSession = await checkExistingSession();
  if (hasSession) {
    document.getElementById('loadBtn').click();
  }


  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('accessToken');
    location.reload();
  });


  function showProgress(current, total) {
    const progress = document.getElementById('progress') || (() => {
      const el = document.createElement('div');
      el.id = 'progress';
      el.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 0;
        height: 3px;
        background: linear-gradient(90deg, #1da1f2, #0d95e8);
        z-index: 9999;
        transition: width 0.2s ease-out;
        box-shadow: 0 0 10px rgba(29, 161, 242, 0.5);
      `;
      document.body.appendChild(el);
      return el;
    })();
    
    const percent = Math.min(100, (current / total) * 100);
    progress.style.width = `${percent}%`;
  }

  // Rate limit helper
  async function rateLimit() {
    const now = Date.now();
    const elapsed = now - state.lastRequestTime;
    const minDelay = 100;
    if (elapsed < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - elapsed));
    }
    state.lastRequestTime = Date.now();
  }

 
  document.getElementById('loadBtn').addEventListener('click', async () => {
    const loadBtn = document.getElementById('loadBtn');
    
    try {
      loadBtn.disabled = true;
      loadBtn.style.opacity = '0.7';
      loadBtn.textContent = 'İşleniyor...';

      let accessJwt = localStorage.getItem('accessToken');
      let did = state.currentUserDid;


      if (!accessJwt) {
  const handle = document.getElementById('handle').value.trim();
  const appPassword = document.getElementById('appPassword').value.trim();

  if (!handle || !appPassword) {
    alert("Lütfen tüm alanları doldurun!");
    return;
  }

  const loginResult = await loginWithRetry(handle, appPassword);
        accessJwt = loginResult.accessJwt;
        did = loginResult.did;
        localStorage.setItem('accessToken', accessJwt);
        state.currentUserDid = did;
        
        document.getElementById('loginForm').classList.add('hidden');
        document.getElementById('logoutBtn').classList.remove('hidden');
      }


      state.followsCache.clear();
      state.followersCache.clear();
      state.profilesCache.clear();

      showProgress(0, 2);
      const [follows, followers] = await Promise.all([
        fetchWithCache(`https://bsky.social/xrpc/app.bsky.graph.getFollows?actor=${did}`, accessJwt, 'followsCache'),
        fetchWithCache(`https://bsky.social/xrpc/app.bsky.graph.getFollowers?actor=${did}`, accessJwt, 'followersCache')
      ]);
      showProgress(2, 2);


      const followsSet = new Set(follows);
      const followersSet = new Set(followers);
      
      const unfollowerDids = follows.filter(did => !followersSet.has(did));
      const toFollowBackDids = followers.filter(did => !followsSet.has(did));


      showProgress(0, unfollowerDids.length + toFollowBackDids.length);
      const [unfollowerProfiles, toFollowBackProfiles] = await Promise.all([
        batchGetProfiles(unfollowerDids, accessJwt, (i) => showProgress(i, unfollowerDids.length + toFollowBackDids.length)),
        batchGetProfiles(toFollowBackDids, accessJwt, (i) => showProgress(unfollowerDids.length + i, unfollowerDids.length + toFollowBackDids.length))
      ]);


      renderResults(unfollowerProfiles, accessJwt, 'results', 'Takip Etmeyenler', 'no-results', 'Takipten Çık');
      renderResults(toFollowBackProfiles, accessJwt, 'followBackResults', 'Sizi Takip Ediyor', 'no-follow-backs', 'Geri Takip Et');


      document.querySelector('.button-container').classList.remove('hidden');
      toggleElementVisibility('#results-section h2', unfollowerProfiles.length > 0);
      toggleElementVisibility('#followBackHeading', toFollowBackProfiles.length > 0);


      setupBulkActions(accessJwt, unfollowerDids, toFollowBackDids);

    } catch (error) {
      console.error("Main error:", error);
      alert(`Hata: ${error.message}`);
      document.querySelector('.button-container').classList.add('hidden');
    } finally {
      document.getElementById('progress').style.width = '100%';
      setTimeout(() => document.getElementById('progress')?.remove(), 500);
    }
  });


  async function loginWithRetry(handle, password, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
      await rateLimit();
      try {
        const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: handle, password })
        });

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After')) || Math.pow(2, i);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }

        const data = await response.json();
        return { accessJwt: data.accessJwt, did: data.did };
      } catch (error) {
        if (i === maxRetries - 1) throw error;
      }
    }
  }


  async function fetchWithCache(endpoint, accessJwt, cacheKey) {
    const cache = state[cacheKey];
    const cacheKeyUrl = endpoint.split('?')[0];
    
    if (cache.has(cacheKeyUrl)) {
      return cache.get(cacheKeyUrl);
    }

    let allItems = [];
    let cursor = null;
    
    do {
      await rateLimit();
      const url = cursor ? `${endpoint}&cursor=${cursor}` : endpoint;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessJwt}` }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      const items = (data.follows || data.followers).map(u => u.did);
      allItems = allItems.concat(items);
      cursor = data.cursor;

   
      if (allItems.length > 5000) break;
    } while (cursor);

    cache.set(cacheKeyUrl, allItems);
    return allItems;
  }


  async function batchGetProfiles(dids, accessJwt, progressCallback) {
    if (!dids.length) return [];
    
    const BATCH_SIZE = 25;
    const profiles = [];
    
    for (let i = 0; i < dids.length; i += BATCH_SIZE) {
      const batch = dids.slice(i, i + BATCH_SIZE);
     
   
      const cachedBatch = batch.filter(did => state.profilesCache.has(did));
      const uncachedBatch = batch.filter(did => !state.profilesCache.has(did));


      cachedBatch.forEach(did => profiles.push(state.profilesCache.get(did)));


      if (uncachedBatch.length) {
        const batchResults = await Promise.all(
          uncachedBatch.map(did => 
            fetch(`https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${did}`, {
              headers: { Authorization: `Bearer ${accessJwt}` }
            })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
          )
        );

        // Cache and store results
        batchResults.forEach((profile, index) => {
          if (profile) {
            state.profilesCache.set(uncachedBatch[index], profile);
            profiles.push(profile);
          }
        });
      }

      progressCallback(Math.min(i + BATCH_SIZE, dids.length));
      if (i + BATCH_SIZE < dids.length) await new Promise(r => setTimeout(r, 200));
    }

    return profiles;
  }


  function renderResults(profiles, accessJwt, containerId, headingText, noResultsId, buttonText) {
    const container = document.getElementById(containerId);
    const heading = containerId === 'results' 
      ? document.querySelector('#results-section h2')
      : document.getElementById('followBackHeading');
    const noResults = document.getElementById(noResultsId);

    if (!profiles.length) {
      container.innerHTML = '';
      if (heading) heading.classList.add('hidden');
      if (noResults) noResults.style.display = 'block';
      return;
    }

    container.innerHTML = '';
    if (heading) {
      heading.textContent = `${headingText} (${profiles.length})`;
      heading.classList.remove('hidden');
    }
    if (noResults) noResults.style.display = 'none';

    // Create a simple list without scrollbar
    const listContainer = document.createElement('div');
    listContainer.style.maxHeight = 'none'; // Remove max height restriction
    listContainer.style.overflow = 'visible'; // Ensure no scrollbar
    
    profiles.forEach(profile => {
      const userCard = document.createElement('div');
      userCard.className = 'user-card';
      userCard.style.display = 'flex';
      userCard.style.alignItems = 'center';
      userCard.style.padding = '10px';
      userCard.style.borderBottom = '1px solid #eee';
      userCard.innerHTML = `
        ${profile.avatar ? `<img src="${profile.avatar}" alt="${profile.handle}" style="width:30px;height:30px;border-radius:50%;margin-right:10px;">` : ''}
        <span style="flex-grow:1">@${profile.handle}</span>
        <button class="${containerId === 'results' ? 'unfollow-btn' : 'follow-back-btn'}" 
                data-did="${profile.did}"
                style="padding:5px 10px;background:#1da1f2;color:white;border:none;border-radius:4px;cursor:pointer">
          ${buttonText}
        </button>
      `;
      listContainer.appendChild(userCard);
    });

    container.appendChild(listContainer);

    // Event delegation for buttons
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('.unfollow-btn, .follow-back-btn');
      if (!btn) return;

      const action = btn.classList.contains('unfollow-btn') ? 'unfollow' : 'follow';
      const targetDid = btn.dataset.did;
      
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.textContent = 'İşleniyor...';
      
      try {
        const success = action === 'unfollow'
          ? await optimizedUnfollowUser(targetDid, accessJwt)
          : await optimizedFollowUser(targetDid, accessJwt);
        
        if (success) {
          btn.textContent = 'Başarılı!';
          btn.style.background = '#4CAF50';
          setTimeout(() => {
            btn.closest('.user-card').style.transition = 'opacity 0.3s';
            btn.closest('.user-card').style.opacity = '0';
            setTimeout(() => btn.closest('.user-card').remove(), 300);
          }, 1000);
        } else {
          btn.textContent = 'Hata!';
          btn.style.background = '#f44336';
          setTimeout(() => {
            btn.textContent = buttonText;
            btn.style.background = '#1da1f2';
            btn.disabled = false;
            btn.style.opacity = '1';
          }, 2000);
        }
      } catch (error) {
        console.error(`${action} error:`, error);
        btn.textContent = 'Hata!';
        btn.style.background = '#f44336';
        setTimeout(() => {
          btn.textContent = buttonText;
          btn.style.background = '#1da1f2';
          btn.disabled = false;
          btn.style.opacity = '1';
        }, 2000);
      }
    });
  }


  async function optimizedFollowUser(targetDid, accessJwt) {
    await rateLimit();
    try {
      const response = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessJwt}`
        },
        body: JSON.stringify({
          repo: state.currentUserDid,
          collection: 'app.bsky.graph.follow',
          record: {
            subject: targetDid,
            createdAt: new Date().toISOString()
          }
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Follow failed');
      }
      return true;
    } catch (error) {
      console.error('Follow error:', error);
      return false;
    }
  }

  async function optimizedUnfollowUser(targetDid, accessJwt) {
    await rateLimit();
    try {

      const profile = await fetch(`https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${targetDid}`, {
        headers: { Authorization: `Bearer ${accessJwt}` }
      }).then(r => r.json());

      if (!profile?.viewer?.following) return false;

      const rkey = profile.viewer.following.split('/').pop();
      const response = await fetch('https://bsky.social/xrpc/com.atproto.repo.applyWrites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessJwt}`
        },
        body: JSON.stringify({
          repo: state.currentUserDid,
          writes: [{ 
            $type: "com.atproto.repo.applyWrites#delete",
            collection: "app.bsky.graph.follow",
            rkey 
          }]
        })
      });

      return response.ok;
    } catch (error) {
      console.error('Unfollow error:', error);
      return false;
    }
  }


  function setupBulkActions(accessJwt, unfollowerDids, toFollowBackDids) {

    const unfollowAllBtn = document.getElementById('unfollowAllBtn');
    if (unfollowAllBtn) {
      unfollowAllBtn.onclick = async () => {
        if (!unfollowerDids.length) {
          alert("Takipten çıkılacak kullanıcı bulunamadı.");
          return;
        }
        
        const confirmed = confirm(`${unfollowerDids.length} kullanıcıyı takipten çıkarmak istediğinize emin misiniz?`);
        if (!confirmed) return;
        
        unfollowAllBtn.disabled = true;
        unfollowAllBtn.textContent = "İşleniyor...";
        
        const results = await batchProcessActions('unfollow', unfollowerDids, accessJwt);
        
        unfollowAllBtn.disabled = false;
        unfollowAllBtn.textContent = "Tümünü Takipten Çık";
        
        alert(`${results.filter(Boolean).length}/${unfollowerDids.length} kullanıcı takipten çıkarıldı.`);
        document.getElementById('loadBtn').click();
      };
    }


    const followBackAllBtn = document.getElementById('followBackAllBtn');
    if (followBackAllBtn) {
      followBackAllBtn.onclick = async () => {
        if (!toFollowBackDids.length) {
          alert("Geri takip edilecek kullanıcı bulunamadı.");
          return;
        }
        
        const confirmed = confirm(`${toFollowBackDids.length} kullanıcıyı geri takip etmek istediğinize emin misiniz?`);
        if (!confirmed) return;
        
        followBackAllBtn.disabled = true;
        followBackAllBtn.textContent = "İşleniyor...";
        
        const results = await batchProcessActions('follow', toFollowBackDids, accessJwt);
        
        followBackAllBtn.disabled = false;
        followBackAllBtn.textContent = "Tümünü Geri Takip Et";
        
        alert(`${results.filter(Boolean).length}/${toFollowBackDids.length} kullanıcı geri takip edildi.`);
        document.getElementById('loadBtn').click();
      };
    }
  }


  async function batchProcessActions(action, dids, accessJwt) {
    const BATCH_SIZE = 10;
    const results = [];
    const progress = document.createElement('div');
    progress.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 10px 20px;
      background: rgba(0,0,0,0.8);
      color: white;
      border-radius: 5px;
      z-index: 10000;
    `;
    document.body.appendChild(progress);
    
    for (let i = 0; i < dids.length; i += BATCH_SIZE) {
      const batch = dids.slice(i, i + BATCH_SIZE);
      progress.textContent = `${action} işleniyor: ${i}/${dids.length}`;
      
      const batchResults = await Promise.all(
        batch.map(did => action === 'follow'
          ? optimizedFollowUser(did, accessJwt)
          : optimizedUnfollowUser(did, accessJwt))
      );
      
      results.push(...batchResults);
      await new Promise(r => setTimeout(r, 500)); // Batch delay
    }
    
    progress.remove();
    return results;
  }


  function toggleElementVisibility(selector, visible) {
    const element = document.querySelector(selector);
    if (element) {
      visible ? element.classList.remove('hidden') : element.classList.add('hidden');
    }
  }
});