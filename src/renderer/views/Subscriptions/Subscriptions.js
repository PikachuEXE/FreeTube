import { defineComponent } from 'vue'
import { mapActions, mapMutations } from 'vuex'
import FtLoader from '../../components/ft-loader/ft-loader.vue'
import FtCard from '../../components/ft-card/ft-card.vue'
import FtButton from '../../components/ft-button/ft-button.vue'
import FtIconButton from '../../components/ft-icon-button/ft-icon-button.vue'
import FtFlexBox from '../../components/ft-flex-box/ft-flex-box.vue'
import FtElementList from '../../components/ft-element-list/ft-element-list.vue'
import FtChannelBubble from '../../components/ft-channel-bubble/ft-channel-bubble.vue'

import { calculatePublishedDate, copyToClipboard, showToast } from '../../helpers/utils'
import {
  invidiousGetChannelVideos,
  invidiousGetChannelLiveStreams,
} from '../../helpers/api/invidious'
import {
  getLocalChannelVideos,
  getLocalChannelLiveStreams,
} from '../../helpers/api/local'

export default defineComponent({
  name: 'Subscriptions',
  components: {
    'ft-loader': FtLoader,
    'ft-card': FtCard,
    'ft-button': FtButton,
    'ft-icon-button': FtIconButton,
    'ft-flex-box': FtFlexBox,
    'ft-element-list': FtElementList,
    'ft-channel-bubble': FtChannelBubble
  },
  data: function () {
    return {
      isLoading: false,
      dataLimit: 100,
      videoList: [],
      liveStreamList: [],
      rssFeedEntryList: [],
      errorChannels: [],
      attemptedFetchForVideos: false,
      attemptedFetchForLiveStreams: false,
      attemptedFetchForRssFeedEntries: false,
      rssFeedDisplayed: false,
      currentTabId: 'default',
    }
  },
  computed: {
    backendPreference: function () {
      return this.$store.getters.getBackendPreference
    },

    backendFallback: function () {
      return this.$store.getters.getBackendFallback
    },

    currentInvidiousInstance: function () {
      return this.$store.getters.getCurrentInvidiousInstance
    },

    hideWatchedSubs: function () {
      return this.$store.getters.getHideWatchedSubs
    },

    useRssFeeds: function () {
      return this.$store.getters.getUseRssFeeds
    },
    shouldForceRssFeed() {
      // When preference set to use RSS it does not count as "forcing"
      if (this.useRssFeeds) { return false }

      return this.activeSubscriptionList.length >= 125
    },

    activeFeedEntryList() {
      if (this.rssFeedDisplayed) {
        return this.activeRssFeedEntryList
      }

      if (this.currentTabId === 'liveStreams') {
        return this.activeLiveStreamList
      } else {
        // 'default'
        return this.activeVideoList
      }
    },
    activeRssFeedEntryList() {
      if (this.rssFeedEntryList.length < this.dataLimit) {
        return this.rssFeedEntryList
      } else {
        return this.rssFeedEntryList.slice(0, this.dataLimit)
      }
    },
    activeVideoList() {
      if (this.videoList.length < this.dataLimit) {
        return this.videoList
      } else {
        return this.videoList.slice(0, this.dataLimit)
      }
    },
    activeLiveStreamList() {
      if (this.liveStreamList.length < this.dataLimit) {
        return this.liveStreamList
      } else {
        return this.liveStreamList.slice(0, this.dataLimit)
      }
    },

    attemptedFetch() {
      if (this.rssFeedDisplayed) {
        return this.attemptedFetchForRssFeedEntries
      }

      if (this.currentTabId === 'liveStreams') {
        return this.attemptedFetchForLiveStreams
      } else {
        // 'default'
        return this.attemptedFetchForVideos
      }
    },

    activeProfile: function () {
      return this.$store.getters.getActiveProfile
    },
    activeProfileId: function () {
      return this.activeProfile._id
    },

    cacheEntriesForAllActiveProfileChannels() {
      const entries = []
      this.activeSubscriptionList.forEach((channel) => {
        const cacheEntry = this.$store.getters.getSubscriptionsCacheEntriesForOneChannel(channel.id)
        if (cacheEntry == null) { return }

        entries.push(cacheEntry)
      })
      return entries
    },
    videoCacheForAllActiveProfileChannelsPresent() {
      if (this.cacheEntriesForAllActiveProfileChannels.length === 0) { return false }
      if (this.cacheEntriesForAllActiveProfileChannels.length < this.activeSubscriptionList.length) { return false }

      return this.cacheEntriesForAllActiveProfileChannels.every((cacheEntry) => {
        return cacheEntry.videos != null
      })
    },
    liveStreamCacheForAllActiveProfileChannelsPresent() {
      if (this.cacheEntriesForAllActiveProfileChannels.length === 0) { return false }
      if (this.cacheEntriesForAllActiveProfileChannels.length < this.activeSubscriptionList.length) { return false }

      return this.cacheEntriesForAllActiveProfileChannels.every((cacheEntry) => {
        return cacheEntry.liveStreams != null
      })
    },
    rssFeedEntryCacheForAllActiveProfileChannelsPresent() {
      if (this.cacheEntriesForAllActiveProfileChannels.length === 0) { return false }
      if (this.cacheEntriesForAllActiveProfileChannels.length < this.activeSubscriptionList.length) { return false }

      return this.cacheEntriesForAllActiveProfileChannels.every((cacheEntry) => {
        return cacheEntry.rssFeedEntries != null
      })
    },

    historyCache: function () {
      return this.$store.getters.getHistoryCache
    },

    activeSubscriptionList: function () {
      return this.activeProfile.subscriptions
    },

    hideLiveStreams: function() {
      return this.$store.getters.getHideLiveStreams
    },

    hideUpcomingPremieres: function () {
      return this.$store.getters.getHideUpcomingPremieres
    },

    fetchSubscriptionsAutomatically: function() {
      return this.$store.getters.getFetchSubscriptionsAutomatically
    },

    headingText() {
      const defaultText = this.$t('Subscriptions.Subscriptions')
      if (!this.rssFeedDisplayed) { return defaultText }

      return `${defaultText} (RSS)`
    },
  },
  watch: {
    activeProfile: async function (_) {
      this.isLoading = true
      this.rssFeedDisplayed = this.useRssFeeds
      this.loadFeedFromCacheSometimes()
    },
    useRssFeeds(value) {
      this.rssFeedDisplayed = value
    },
    currentTabId(value) {
      // Save last used tab, restore when view mounted again
      sessionStorage.setItem('Subscriptions/currentTabId', value)
    },
    rssFeedDisplayed(value) {
      // To be restored when view mounted again
      sessionStorage.setItem('Subscriptions/rssFeedDisplayed', value)
    },
  },
  mounted: async function () {
    // Restore rssFeedDisplayed
    const lastRssFeedDisplayed = sessionStorage.getItem('Subscriptions/rssFeedDisplayed')
    if (lastRssFeedDisplayed != null) {
      this.rssFeedDisplayed = lastRssFeedDisplayed
    } else {
      this.rssFeedDisplayed = this.useRssFeeds
    }

    // Restore currentTab
    const lastCurrentTabId = sessionStorage.getItem('Subscriptions/currentTabId')
    if (lastCurrentTabId != null) { this.currentTabId = lastCurrentTabId }

    document.addEventListener('keydown', this.keyboardShortcutHandler)

    this.isLoading = true
    const dataLimit = sessionStorage.getItem('subscriptionLimit')
    if (dataLimit !== null) {
      this.dataLimit = dataLimit
    }

    this.loadFeedFromCacheSometimes()
  },
  beforeDestroy: function () {
    document.removeEventListener('keydown', this.keyboardShortcutHandler)
  },
  methods: {
    /**
     * @param {string} tabId
     */
    changeTab(tabId) {
      this.currentTabId = tabId

      this.loadFeedFromCacheSometimes()
    },

    /**
     * @param {KeyboardEvent} event
     * @param {string} tabId
     */
    focusTab: function (event, tabId) {
      if (event.altKey) { return }

      event.preventDefault()
      if (tabId === 'liveStreams') {
        this.$refs.liveStreamsTab.focus()
      } else {
        // 'default'
        this.$refs.defaultTab.focus()
      }
      this.$emit('showOutlines')
    },

    loadFeedFromCacheSometimes() {
      if (this.rssFeedDisplayed) {
        this.loadRssFeedEntriesFromCacheSometimes()
        return
      }

      if (this.currentTabId === 'liveStreams') {
        this.loadLiveStreamsFromCacheSometimes()
      } else {
        // 'default'
        this.loadVideosFromCacheSometimes()
      }
    },

    loadVideosFromCacheSometimes() {
      // This method is called on view visible
      if (this.videoCacheForAllActiveProfileChannelsPresent) {
        this.loadVideosFromCacheForAllActiveProfileChannels()
        return
      }

      this.maybeLoadVideosForSubscriptionsFromRemote()
    },
    async loadVideosFromCacheForAllActiveProfileChannels() {
      const videoList = []
      this.activeSubscriptionList.forEach((channel) => {
        const channelCacheEntry = this.$store.getters.getSubscriptionsCacheEntriesForOneChannel(channel.id)

        videoList.push(...channelCacheEntry.videos)
      })
      this.updateVideoListAfterProcessing(videoList)
      this.isLoading = false
    },

    loadLiveStreamsFromCacheSometimes() {
      // This method is called on view visible
      if (this.liveStreamCacheForAllActiveProfileChannelsPresent) {
        this.loadLiveStreamsFromCacheForAllActiveProfileChannels()
        return
      }

      this.maybeLoadLiveStreamsForSubscriptionsFromRemote()
    },
    async loadLiveStreamsFromCacheForAllActiveProfileChannels() {
      const entries = []
      this.activeSubscriptionList.forEach((channel) => {
        const channelCacheEntry = this.$store.getters.getSubscriptionsCacheEntriesForOneChannel(channel.id)

        entries.push(...channelCacheEntry.liveStreams)
      })
      this.updateLiveStreamListAfterProcessing(entries)
      this.isLoading = false
    },

    loadRssFeedEntriesFromCacheSometimes() {
      // This method is called on view visible
      if (this.rssFeedEntryCacheForAllActiveProfileChannelsPresent) {
        this.loadRssFeedEntriesFromCacheForAllActiveProfileChannels()
        return
      }

      this.maybeLoadRssFeedEntriesForSubscriptionsFromRemote()
    },
    async loadRssFeedEntriesFromCacheForAllActiveProfileChannels() {
      const entries = []
      this.activeSubscriptionList.forEach((channel) => {
        const channelCacheEntry = this.$store.getters.getSubscriptionsCacheEntriesForOneChannel(channel.id)

        entries.push(...channelCacheEntry.rssFeedEntries)
      })
      this.updateRssFeedEntryListAfterProcessing(entries)
      this.isLoading = false
    },

    goToChannel: function (id) {
      this.$router.push({ path: `/channel/${id}` })
    },

    loadFeedEntriesForSubscriptionsFromRemote: function () {
      if (this.rssFeedDisplayed) {
        this.loadRssFeedEntriesForSubscriptionsFromRemote()
        return
      }

      if (this.currentTabId === 'liveStreams') {
        this.loadLiveStreamsForSubscriptionsFromRemote()
      } else {
        // 'default'
        this.loadVideosForSubscriptionsFromRemote()
      }
    },

    loadVideosForSubscriptionsFromRemote: async function () {
      if (this.activeSubscriptionList.length === 0) {
        this.isLoading = false
        this.videoList = []
        return
      }

      const channelsToLoadFromRemote = this.activeSubscriptionList
      const videoList = []
      let channelCount = 0
      this.isLoading = true

      if (this.shouldForceRssFeed) {
        showToast(
          this.$t('Subscriptions["This profile has a large number of subscriptions. Forcing RSS to avoid rate limiting"]'),
          10000
        )
        this.rssFeedDisplayed = true
        this.loadRssFeedEntriesForSubscriptionsFromRemote()
        return
      }
      this.updateShowProgressBar(true)
      this.setProgressBarPercentage(0)
      this.attemptedFetchForVideos = true

      this.errorChannels = []
      const videoListFromRemote = (await Promise.all(channelsToLoadFromRemote.map(async (channel) => {
        let videos = []
        if (!process.env.IS_ELECTRON || this.backendPreference === 'invidious') {
          videos = await this.getChannelVideosInvidiousScraper(channel)
        } else {
          videos = await this.getChannelVideosLocalScraper(channel)
        }

        channelCount++
        const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
        this.setProgressBarPercentage(percentageComplete)
        this.updateSubscriptionsCacheForOneChannel({
          channelId: channel.id,
          videos: videos,
        })
        return videos
      }))).flatMap((o) => o)
      videoList.push(...videoListFromRemote)

      this.updateVideoListAfterProcessing(videoList)
      this.isLoading = false
      this.updateShowProgressBar(false)
    },

    loadLiveStreamsForSubscriptionsFromRemote: async function () {
      if (this.activeSubscriptionList.length === 0) {
        this.isLoading = false
        this.liveStreamList = []
        return
      }

      const channelsToLoadFromRemote = this.activeSubscriptionList
      const allEntries = []
      let channelCount = 0
      this.isLoading = true

      if (this.shouldForceRssFeed) {
        showToast(
          this.$t('Subscriptions["This profile has a large number of subscriptions. Forcing RSS to avoid rate limiting"]'),
          10000
        )
        this.rssFeedDisplayed = true
        this.loadRssFeedEntriesForSubscriptionsFromRemote()
        return
      }
      this.updateShowProgressBar(true)
      this.setProgressBarPercentage(0)
      this.attemptedFetchForLiveStreams = true

      this.errorChannels = []
      const entriesFromRemote = (await Promise.all(channelsToLoadFromRemote.map(async (channel) => {
        let entries = []
        if (!process.env.IS_ELECTRON || this.backendPreference === 'invidious') {
          entries = await this.getChannelLiveStreamsInvidiousScraper(channel)
        } else {
          entries = await this.getChannelLiveStreamsLocalScraper(channel)
        }

        channelCount++
        const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
        this.setProgressBarPercentage(percentageComplete)
        this.updateSubscriptionsCacheForOneChannel({
          channelId: channel.id,
          liveStreams: entries,
        })
        return entries
      }))).flatMap((o) => o)
      allEntries.push(...entriesFromRemote)

      this.updateLiveStreamListAfterProcessing(allEntries)
      this.isLoading = false
      this.updateShowProgressBar(false)
    },

    loadRssFeedEntriesForSubscriptionsFromRemote: async function () {
      if (this.activeSubscriptionList.length === 0) {
        this.isLoading = false
        this.rssFeedEntryList = []
        return
      }

      const channelsToLoadFromRemote = this.activeSubscriptionList
      const allEntries = []
      let channelCount = 0
      this.isLoading = true

      this.updateShowProgressBar(true)
      this.setProgressBarPercentage(0)
      this.attemptedFetchForLiveStreams = true

      this.errorChannels = []
      const entriesFromRemote = (await Promise.all(channelsToLoadFromRemote.map(async (channel) => {
        let entries = []
        if (!process.env.IS_ELECTRON || this.backendPreference === 'invidious') {
          entries = await this.getChannelRssEntriesInvidious(channel)
        } else {
          entries = await this.getChannelRssEntriesLocal(channel)
        }

        channelCount++
        const percentageComplete = (channelCount / channelsToLoadFromRemote.length) * 100
        this.setProgressBarPercentage(percentageComplete)
        this.updateSubscriptionsCacheForOneChannel({
          channelId: channel.id,
          rssFeedEntries: entries,
        })
        return entries
      }))).flatMap((o) => o)
      allEntries.push(...entriesFromRemote)

      this.updateRssFeedEntryListAfterProcessing(allEntries)
      this.isLoading = false
      this.updateShowProgressBar(false)
    },

    updateVideoListAfterProcessing(videoList) {
      this.videoList = this.processFeedEntries(videoList)
    },
    updateLiveStreamListAfterProcessing(liveStreamList) {
      this.liveStreamList = this.processFeedEntries(liveStreamList)
    },
    updateRssFeedEntryListAfterProcessing(rssFeedEntryList) {
      this.rssFeedEntryList = this.processFeedEntries(rssFeedEntryList)
    },
    processFeedEntries(entries) {
      // Filtering and sorting based in preference
      entries.sort((a, b) => {
        return b.publishedDate - a.publishedDate
      })
      if (this.hideLiveStreams) {
        entries = entries.filter(item => {
          return (!item.liveNow && !item.isUpcoming)
        })
      }
      if (this.hideUpcomingPremieres) {
        entries = entries.filter(item => {
          if (item.isRSS) {
            // viewCount is our only method of detecting premieres in RSS
            // data without sending an additional request.
            // If we ever get a better flag, use it here instead.
            return item.viewCount !== '0'
          }
          // Observed for premieres in Local API Subscriptions.
          return item.premiereDate == null
        })
      }

      return entries.filter((video) => {
        if (this.hideWatchedSubs) {
          const historyIndex = this.historyCache.findIndex((x) => {
            return x.videoId === video.videoId
          })

          return historyIndex === -1
        } else {
          return true
        }
      })
    },

    maybeLoadVideosForSubscriptionsFromRemote: async function () {
      if (this.fetchSubscriptionsAutomatically) {
        // `this.isLoading = false` is called inside `loadVideosForSubscriptionsFromRemote` when needed
        await this.loadVideosForSubscriptionsFromRemote()
      } else {
        this.videoList = []
        this.attemptedFetchForVideos = false
        this.isLoading = false
      }
    },

    getChannelVideosLocalScraper: async function (channel, failedAttempts = 0) {
      try {
        const videos = await getLocalChannelVideos(channel.id)

        if (videos === null) {
          this.errorChannels.push(channel)
          return []
        }

        videos.map(video => {
          if (video.liveNow) {
            video.publishedDate = new Date().getTime()
          } else if (video.isUpcoming) {
            video.publishedDate = video.premiereDate
          } else {
            video.publishedDate = calculatePublishedDate(video.publishedText)
          }
          return video
        })

        return videos
      } catch (err) {
        console.error(err)
        const errorMessage = this.$t('Local API Error (Click to copy)')
        showToast(`${errorMessage}: ${err}`, 10000, () => {
          copyToClipboard(err)
        })
        switch (failedAttempts) {
          case 0:
            if (this.backendFallback) {
              showToast(this.$t('Falling back to Invidious API'))
              return await this.getChannelVideosInvidiousScraper(channel, failedAttempts + 1)
            } else {
              return []
            }
          default:
            return []
        }
      }
    },

    getChannelRssEntriesLocal: async function (channel, failedAttempts = 0) {
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`

      try {
        const response = await fetch(feedUrl)

        if (response.status === 404) {
          this.errorChannels.push(channel)
          return []
        }

        return await this.parseYouTubeRSSFeed(await response.text(), channel.id)
      } catch (error) {
        console.error(error)
        const errorMessage = this.$t('Local API Error (Click to copy)')
        showToast(`${errorMessage}: ${error}`, 10000, () => {
          copyToClipboard(error)
        })
        switch (failedAttempts) {
          case 0:
            if (this.backendFallback) {
              showToast(this.$t('Falling back to Invidious API'))
              return this.getChannelRssEntriesInvidious(channel, failedAttempts + 1)
            } else {
              return []
            }
          default:
            return []
        }
      }
    },

    getChannelVideosInvidiousScraper: function (channel, failedAttempts = 0) {
      return new Promise((resolve, reject) => {
        invidiousGetChannelVideos(channel.id).then(async (result) => {
          resolve(await Promise.all(result.map((video) => {
            if (video.liveNow) {
              video.publishedDate = new Date().getTime()
            } else if (video.isUpcoming) {
              video.publishedDate = new Date(video.premiereTimestamp * 1000)
            } else {
              video.publishedDate = new Date(video.published * 1000)
            }
            return video
          })))
        }).catch((err) => {
          console.error(err)
          const errorMessage = this.$t('Invidious API Error (Click to copy)')
          showToast(`${errorMessage}: ${err.responseText}`, 10000, () => {
            copyToClipboard(err.responseText)
          })
          switch (failedAttempts) {
            case 0:
              if (process.env.IS_ELECTRON && this.backendFallback) {
                showToast(this.$t('Falling back to the local API'))
                resolve(this.getChannelVideosLocalScraper(channel, failedAttempts + 1))
              } else {
                resolve([])
              }
              break
            default:
              resolve([])
          }
        })
      })
    },

    getChannelRssEntriesInvidious: async function (channel, failedAttempts = 0) {
      const feedUrl = `${this.currentInvidiousInstance}/feed/channel/${channel.id}`

      try {
        const response = await fetch(feedUrl)

        if (response.status === 500) {
          this.errorChannels.push(channel)
          return []
        }

        return await this.parseYouTubeRSSFeed(await response.text(), channel.id)
      } catch (error) {
        console.error(error)
        const errorMessage = this.$t('Invidious API Error (Click to copy)')
        showToast(`${errorMessage}: ${error}`, 10000, () => {
          copyToClipboard(error)
        })
        switch (failedAttempts) {
          case 0:
            if (process.env.IS_ELECTRON && this.backendFallback) {
              showToast(this.$t('Falling back to the local API'))
              return this.getChannelRssEntriesLocal(channel, failedAttempts + 1)
            } else {
              return []
            }
          default:
            return []
        }
      }
    },

    maybeLoadLiveStreamsForSubscriptionsFromRemote: async function () {
      if (this.fetchSubscriptionsAutomatically) {
        // `this.isLoading = false` is called inside `loadVideosForSubscriptionsFromRemote` when needed
        await this.loadLiveStreamsForSubscriptionsFromRemote()
      } else {
        this.liveStreamList = []
        this.attemptedFetchForLiveStreams = false
        this.isLoading = false
      }
    },

    maybeLoadRssFeedEntriesForSubscriptionsFromRemote: async function () {
      if (this.fetchSubscriptionsAutomatically) {
        // `this.isLoading = false` is called inside `loadVideosForSubscriptionsFromRemote` when needed
        await this.loadRssFeedEntriesForSubscriptionsFromRemote()
      } else {
        this.rssFeedEntryList = []
        this.attemptedFetchForRssFeedEntries = false
        this.isLoading = false
      }
    },

    getChannelLiveStreamsLocalScraper: async function (channel, failedAttempts = 0) {
      try {
        const entries = await getLocalChannelLiveStreams(channel.id)

        if (entries === null) {
          this.errorChannels.push(channel)
          return []
        }

        entries.map(entry => {
          if (entry.liveNow) {
            entry.publishedDate = new Date().getTime()
          } else if (entry.isUpcoming) {
            entry.publishedDate = entry.premiereDate
          } else {
            entry.publishedDate = calculatePublishedDate(entry.publishedText)
          }
          return entry
        })

        return entries
      } catch (err) {
        console.error(err)
        const errorMessage = this.$t('Local API Error (Click to copy)')
        showToast(`${errorMessage}: ${err}`, 10000, () => {
          copyToClipboard(err)
        })
        switch (failedAttempts) {
          case 0:
            if (this.backendFallback) {
              showToast(this.$t('Falling back to Invidious API'))
              return await this.getChannelLiveStreamsInvidiousScraper(channel, failedAttempts + 1)
            } else {
              return []
            }
          default:
            return []
        }
      }
    },

    getChannelLiveStreamsInvidiousScraper: function (channel, failedAttempts = 0) {
      return new Promise((resolve, reject) => {
        invidiousGetChannelLiveStreams(channel.id).then(async (result) => {
          resolve(await Promise.all(result.map((video) => {
            if (video.liveNow) {
              video.publishedDate = new Date().getTime()
            } else if (video.isUpcoming) {
              video.publishedDate = new Date(video.premiereTimestamp * 1000)
            } else {
              video.publishedDate = new Date(video.published * 1000)
            }
            return video
          })))
        }).catch((err) => {
          console.error(err)
          const errorMessage = this.$t('Invidious API Error (Click to copy)')
          showToast(`${errorMessage}: ${err.responseText}`, 10000, () => {
            copyToClipboard(err.responseText)
          })
          switch (failedAttempts) {
            case 0:
              if (process.env.IS_ELECTRON && this.backendFallback) {
                showToast(this.$t('Falling back to the local API'))
                resolve(this.getChannelLiveStreamsLocalScraper(channel, failedAttempts + 1))
              } else {
                resolve([])
              }
              break
            default:
              resolve([])
          }
        })
      })
    },

    async parseYouTubeRSSFeed(rssString, channelId) {
      const xmlDom = new DOMParser().parseFromString(rssString, 'application/xml')

      const channelName = xmlDom.querySelector('author > name').textContent
      const entries = xmlDom.querySelectorAll('entry')

      const promises = []

      for (const entry of entries) {
        promises.push(this.parseRSSEntry(entry, channelId, channelName))
      }

      return await Promise.all(promises)
    },

    async parseRSSEntry(entry, channelId, channelName) {
      const published = new Date(entry.querySelector('published').textContent)
      return {
        authorId: channelId,
        author: channelName,
        // querySelector doesn't support xml namespaces so we have to use getElementsByTagName here
        videoId: entry.getElementsByTagName('yt:videoId')[0].textContent,
        title: entry.querySelector('title').textContent,
        publishedDate: published,
        publishedText: published.toLocaleString(),
        viewCount: entry.getElementsByTagName('media:statistics')[0]?.getAttribute('views') || null,
        type: 'video',
        lengthSeconds: '0:00',
        isRSS: true
      }
    },

    increaseLimit: function () {
      this.dataLimit += 100
      sessionStorage.setItem('subscriptionLimit', this.dataLimit)
    },

    /**
     * This function `keyboardShortcutHandler` should always be at the bottom of this file
     * @param {KeyboardEvent} event the keyboard event
     */
    keyboardShortcutHandler: function (event) {
      if (event.ctrlKey || document.activeElement.classList.contains('ft-input')) {
        return
      }
      // Avoid handling events due to user holding a key (not released)
      // https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/repeat
      if (event.repeat) { return }

      switch (event.key) {
        case 'r':
        case 'R':
          if (!this.isLoading) {
            this.loadFeedEntriesForSubscriptionsFromRemote()
          }
          break
      }
    },

    ...mapActions([
      'updateShowProgressBar',
      'updateSubscriptionsCacheForOneChannel',
    ]),

    ...mapMutations([
      'setProgressBarPercentage'
    ])
  }
})
