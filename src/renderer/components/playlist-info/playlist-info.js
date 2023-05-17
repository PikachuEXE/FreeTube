import { defineComponent } from 'vue'
import { mapActions } from 'vuex'
import FtShareButton from '../ft-share-button/ft-share-button.vue'
import FtFlexBox from '../ft-flex-box/ft-flex-box.vue'
import FtIconButton from '../ft-icon-button/ft-icon-button.vue'
import FtInput from '../ft-input/ft-input.vue'
import FtPrompt from '../ft-prompt/ft-prompt.vue'
import {
  showToast,
} from '../../helpers/utils'

export default defineComponent({
  name: 'PlaylistInfo',
  components: {
    'ft-share-button': FtShareButton,
    'ft-flex-box': FtFlexBox,
    'ft-icon-button': FtIconButton,
    'ft-input': FtInput,
    'ft-prompt': FtPrompt,
  },
  props: {
    id: {
      type: String,
      required: true,
    },
    firstVideoId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    channelThumbnail: {
      type: String,
      required: true,
    },
    channelName: {
      type: String,
      required: true,
    },
    channelId: {
      type: String,
      required: true,
    },
    videoCount: {
      type: Number,
      required: true,
    },
    videos: {
      type: Array,
      required: true
    },
    viewCount: {
      type: Number,
      required: true,
    },
    lastUpdated: {
      type: String,
      default: undefined,
    },
    description: {
      type: String,
      required: true,
    },
    infoSource: {
      type: String,
      required: true,
    },
  },
  data: function () {
    return {
      editMode: false,
      showDeletePlaylistPrompt: false,
      showRemoveVideosOnWatchPrompt: false,
      newTitle: '',
      newDescription: '',
      deletePlaylistPromptValues: [
        'yes',
        'no'
      ],
    }
  },
  computed: {
    hideSharingActions: function () {
      return this.$store.getters.getHideSharingActions
    },

    currentInvidiousInstance: function () {
      return this.$store.getters.getCurrentInvidiousInstance
    },

    historyCache: function () {
      return this.$store.getters.getHistoryCache
    },

    thumbnailPreference: function () {
      return this.$store.getters.getThumbnailPreference
    },

    hideViews: function () {
      return this.$store.getters.getHideVideoViews
    },

    selectedUserPlaylist: function () {
      return this.$store.getters.getPlaylist(this.id)
    },

    deletePlaylistPromptNames: function () {
      return [
        this.$t('Yes'),
        this.$t('No')
      ]
    },

    thumbnail: function () {
      switch (this.thumbnailPreference) {
        case 'start':
          return `https://i.ytimg.com/vi/${this.firstVideoId}/mq1.jpg`
        case 'middle':
          return `https://i.ytimg.com/vi/${this.firstVideoId}/mq2.jpg`
        case 'end':
          return `https://i.ytimg.com/vi/${this.firstVideoId}/mq3.jpg`
        default:
          return `https://i.ytimg.com/vi/${this.firstVideoId}/mqdefault.jpg`
      }
    },

    deletePlaylistButtonVisible: function() {
      if (this.infoSource !== 'user') { return false }
      // Cannot delete during edit
      if (this.editMode) { return false }

      // Cannot delete protected playlist
      return !this.selectedUserPlaylist.protected
    },

    sharePlaylistButtonVisible: function() {
      // Only online playlists can be shared
      if (this.infoSource === 'user') { return false }

      // Cannot delete protected playlist
      return !this.hideSharingActions
    },
  },
  mounted: function () {
    this.newTitle = this.title
    this.newDescription = this.description
  },
  methods: {
    copyPlaylist: function () {
      this.showCreatePlaylistPrompt({
        title: this.title,
        videos: this.videos
      })
    },

    savePlaylistInfo: function () {
      const playlist = {
        playlistName: this.newTitle,
        protected: this.selectedUserPlaylist.protected,
        removeOnWatched: this.selectedUserPlaylist.removeOnWatched,
        description: this.newDescription,
        videos: this.selectedUserPlaylist.videos,
        _id: this.id,
      }
      try {
        this.updatePlaylist(playlist)
        showToast('Playlist has been updated.')
      } catch (e) {
        showToast('There was an issue with updating this playlist.')
        console.error(e)
      } finally {
        this.exitEditMode()
      }
    },

    enterEditMode: function () {
      this.newTitle = this.title
      this.newDescription = this.description
      this.editMode = true
    },

    exitEditMode: function () {
      this.editMode = false
    },

    handleRemoveVideosOnWatchPromptAnswer: function (option) {
      if (option === 'yes') {
        const videosToWatch = this.selectedUserPlaylist.videos.filter((video) => {
          const watchedIndex = this.historyCache.findIndex((history) => {
            return history.videoId === video.videoId
          })

          return watchedIndex === -1
        })

        const videosRemoved = this.selectedUserPlaylist.videos.length - videosToWatch.length

        if (videosRemoved === 0) {
          showToast('There were no videos to remove.')
          this.showRemoveVideosOnWatchPrompt = false
          return
        }

        const playlist = {
          playlistName: this.title,
          protected: this.selectedUserPlaylist.protected,
          removeOnWatched: this.selectedUserPlaylist.removeOnWatched,
          description: this.description,
          videos: videosToWatch,
          _id: this.id
        }
        try {
          this.updatePlaylist(playlist)
          showToast(`${videosRemoved} video(s) have been removed.`)
        } catch (e) {
          showToast('There was an issue with updating this playlist.')
          console.error(e)
        }
      }
      this.showRemoveVideosOnWatchPrompt = false
    },

    handleDeletePlaylistPromptAnswer: function (option) {
      if (option === 'yes') {
        if (this.selectedUserPlaylist.protected) {
          showToast('This playlist is protected and cannot be removed.')
        } else {
          this.removePlaylist(this.id)
          this.$router.push(
            {
              path: '/userPlaylists'
            }
          )
          showToast(`${this.title} has been deleted.`)
        }
      }
      this.showDeletePlaylistPrompt = false
    },

    ...mapActions([
      'showCreatePlaylistPrompt',
      'updatePlaylist',
      'removePlaylist',
    ]),
  },
})
