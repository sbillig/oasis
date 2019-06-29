const lodash = require('lodash')
const pull = require('pull-stream')
const prettyMs = require('pretty-ms')
const debug = require('debug')('oasis')

const cooler = require('./lib/cooler')
const configure = require('./lib/configure')
const markdown = require('./lib/markdown')

const transform = (ssb, messages) => Promise.all(messages.map(async (msg) => {
  debug('transforming %s', msg.key)

  if (msg == null) {
    return
  }

  lodash.set(msg, 'value.meta.md.block', () =>
    markdown(msg.value.content.text, msg.value.content.mentions)
  )

  var filterQuery = {
    $filter: {
      dest: msg.key
    }
  }

  const whoami = await cooler.get(ssb.whoami)

  const referenceStream = await cooler.read(ssb.backlinks.read, {
    query: [ filterQuery ],
    index: 'DTA', // use asserted timestamps
    private: true,
    meta: true
  })

  const rawVotes = await new Promise((resolve, reject) => {
    pull(
      referenceStream,
      pull.filter(ref =>
        typeof ref.value.content !== 'string' &&
        ref.value.content.type === 'vote' &&
        ref.value.content.vote &&
        typeof ref.value.content.vote.value === 'number' &&
        ref.value.content.vote.value >= 0 &&
        ref.value.content.vote.link === msg.key
      ),
      pull.collect((err, messages) => {
        if (err) return reject(err)
        resolve(messages)
      })
    )
  })

  // { @key: 1, @key2: 0, @key3: 1 }
  //
  // only one vote per person!
  const reducedVotes = rawVotes.reduce((acc, vote) => {
    acc[vote.value.author] = vote.value.content.vote.value
    return acc
  }, {})

  // gets *only* the people who voted 1
  // [ @key, @key, @key ]
  const voters = Object.entries(reducedVotes).filter(e => e[1] === 1).map(e => e[0])

  const name = await cooler.get(
    ssb.about.socialValue, { key: 'name',
      dest: msg.value.author
    }
  )

  const avatarMsg = await cooler.get(
    ssb.about.socialValue, { key: 'image',
      dest: msg.value.author
    }
  )

  const avatarId = avatarMsg != null && typeof avatarMsg.link === 'string'
    ? avatarMsg.link
    : avatarMsg

  const avatarUrl = `http://localhost:8989/blobs/get/${avatarId}`

  const ts = new Date(msg.value.timestamp)
  lodash.set(msg, 'value.meta.timestamp.received.iso8601', ts.toISOString())

  const ago = Date.now() - Number(ts)
  lodash.set(msg, 'value.meta.timestamp.received.since', prettyMs(ago, { compact: true }))
  lodash.set(msg, 'value.meta.author.name', name)
  lodash.set(msg, 'value.meta.author.avatar', {
    id: avatarId,
    url: avatarUrl
  })

  lodash.set(msg, 'value.meta.votes', voters)
  lodash.set(msg, 'value.meta.voted', voters.includes(whoami.id))

  return msg
}))

module.exports = {
  fromFeed: async (feedId, customOptions = {}) => {
    const ssb = await cooler.connect()
    const options = configure({ id: feedId }, customOptions)

    const source = await cooler.read(
      ssb.createUserStream,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter(msg =>
          typeof msg.value.content !== 'string' &&
          msg.value.content.type === 'post'
        ),
        pull.take(32),
        pull.collect((err, messages) => {
          if (err) return reject(err)
          resolve(transform(ssb, messages))
        })
      )
    })

    return messages
  },
  fromHashtag: async (hashtag, customOptions = {}) => {
    const ssb = await cooler.connect()
    const query = [ {
      $filter: {
        dest: '#' + hashtag
      }
    } ]

    const options = configure({ query, index: 'DTA' }, customOptions)

    const source = await cooler.read(
      ssb.backlinks.read, options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter(msg =>
          typeof msg.value.content !== 'string' &&
          msg.value.content.type === 'post'
        ),
        pull.take(32),
        pull.collect((err, messages) => {
          if (err) return reject(err)
          resolve(transform(ssb, messages))
        })
      )
    })

    return messages
  },
  latest: async (customOptions = {}) => {
    const ssb = await cooler.connect()
    const options = configure({
      type: 'post',
      limit: 32
    }, customOptions)

    const source = await cooler.read(
      ssb.messagesByType,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.collect((err, messages) => {
          if (err) return reject(err)
          resolve(transform(ssb, messages))
        })
      )
    })

    return messages
  },
  fromThread: async (msgId, customOptions) => {
    const ssb = await cooler.connect()
    const options = configure({ id: msgId }, customOptions)
    const rawMsg = await cooler.get(ssb.get, options)

    const parents = []

    const getRootAncestor = (msg) => new Promise(async (resolve, reject) => {
      if (typeof msg.value.content === 'string') {
        // Private message we can't decrypt, stop looking for parents.
        return resolve(parents)
      }

      if (typeof msg.value.content.fork === 'string') {
        // It's a message reply, get the parent!
        const fork = await cooler.get(ssb.get, {
          id: msg.value.content.fork,
          meta: true,
          private: true
        })

        resolve(getRootAncestor(fork))
      } else if (typeof msg.value.content.root === 'string') {
        // It's a thread reply, get the parent!
        const root = await cooler.get(ssb.get, {
          id: msg.value.content.root,
          meta: true,
          private: true
        })

        resolve(getRootAncestor(root))
      } else {
        resolve(msg)
      }
    })

    const getReplies = (key) => new Promise(async (resolve, reject) => {
      var filterQuery = {
        $filter: {
          dest: key
        }
      }

      const referenceStream = await cooler.read(ssb.backlinks.read, {
        query: [filterQuery],
        index: 'DTA' // use asserted timestamps
      })

      pull(
        referenceStream,
        pull.filter(msg => {
          const isPost = lodash.get(msg, 'value.content.type') === 'post'
          if (isPost === false) {
            return false
          }

          const root = lodash.get(msg, 'value.content.root')
          const fork = lodash.get(msg, 'value.content.fork')

          if (root !== key && fork !== key) {
            // mention
            return false
          }

          if (fork === key) {
            // not a reply to this post
            // it's a reply *to a reply* of this post
            return false
          }

          return true
        }),
        pull.collect((err, messages) => {
          if (err) return reject(err)
          resolve(messages || undefined)
        })
      )
    })

    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat
    function flattenDeep (arr1) {
      return arr1.reduce((acc, val) => Array.isArray(val) ? acc.concat(flattenDeep(val)) : acc.concat(val), [])
    }

    const getDeepReplies = (key) => new Promise(async (resolve, reject) => {
      const oneDeeper = async (replyKey, depth) => {
        const replies = await getReplies(replyKey)
        debug('replies', replies.map(m => m.key))

        debug('found %s replies for %s', replies.length, replyKey)

        if (replies.length === 0) {
          return replies
        } else {
          return Promise.all(replies.map(async (reply) => {
            const deeperReplies = await oneDeeper(reply.key, depth + 1)
            lodash.set(reply, 'value.meta.thread.depth', depth)
            return [ reply, deeperReplies ]
          }))
        }
      }

      const nestedReplies = [ ...await oneDeeper(key, 1) ]
      const deepReplies = flattenDeep(nestedReplies)

      resolve(deepReplies)
    })

    const rootAncestor = await getRootAncestor(rawMsg)
    const deepReplies = await getDeepReplies(rootAncestor.key)

    debug('deep replies: %O', deepReplies)

    const allMessages = [rootAncestor, ...deepReplies]

    const transformed = await transform(ssb, allMessages)
    return transformed
  }
}