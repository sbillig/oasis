'use strict'

const debug = require('debug')('oasis:model-post')
const lodash = require('lodash')
const prettyMs = require('pretty-ms')
const pull = require('pull-stream')
const pullParallelMap = require('pull-paramap')
const pullSort = require('pull-sort')
const { isRoot, isReply } = require('ssb-thread-schema')

// HACK: https://github.com/ssbc/ssb-thread-schema/issues/4
const isNestedReply = require('ssb-thread-schema/post/nested-reply/validator')

const configure = require('./lib/configure')
const cooler = require('./lib/cooler')
const markdown = require('./lib/markdown')

const maxMessages = 64

const getMessages = async ({ myFeedId, customOptions, ssb, query, filter = null }) => {
  const options = configure({ query, index: 'DTA' }, customOptions)

  const source = await cooler.read(
    ssb.backlinks.read, options
  )

  return new Promise((resolve, reject) => {
    pull(
      source,
      pull.filter((msg) =>
        typeof msg.value.content !== 'string' &&
        msg.value.content.type === 'post' &&
        (filter == null || filter(msg) === true)
      ),
      pull.take(maxMessages),
      pull.collect((err, collectedMessages) => {
        if (err) {
          reject(err)
        } else {
          resolve(transform(ssb, collectedMessages, myFeedId))
        }
      })
    )
  })
}

const transform = (ssb, messages, myFeedId) =>
  Promise.all(messages.map(async (msg) => {
    debug('transforming %s', msg.key)

    if (msg == null) {
      return null
    }

    lodash.set(msg, 'value.meta.md.block', () =>
      markdown(msg.value.content.text, msg.value.content.mentions)
    )

    const filterQuery = {
      $filter: {
        dest: msg.key
      }
    }

    const referenceStream = await cooler.read(ssb.backlinks.read, {
      query: [filterQuery],
      index: 'DTA', // use asserted timestamps
      private: true,
      meta: true
    })

    const rawVotes = await new Promise((resolve, reject) => {
      pull(
        referenceStream,
        pull.filter((ref) => typeof ref.value.content !== 'string' &&
          ref.value.content.type === 'vote' &&
          ref.value.content.vote &&
          typeof ref.value.content.vote.value === 'number' &&
          ref.value.content.vote.value >= 0 &&
          ref.value.content.vote.link === msg.key),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err)
          } else {
            resolve(collectedMessages)
          }
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
    const voters = Object
      .entries(reducedVotes)
      .filter(([, value]) => value === 1)
      .map(([key]) => key)

    const pendingName = cooler.get(
      ssb.about.socialValue, {
        key: 'name',
        dest: msg.value.author
      }
    )

    const pendingAvatarMsg = cooler.get(
      ssb.about.socialValue, {
        key: 'image',
        dest: msg.value.author
      }
    )

    const pending = [pendingName, pendingAvatarMsg]
    const [name, avatarMsg] = await Promise.all(pending)

    const nullImage = `&${'0'.repeat(43)}=.sha256`
    const avatarId = avatarMsg != null && typeof avatarMsg.link === 'string'
      ? avatarMsg.link || nullImage
      : avatarMsg || nullImage

    const avatarUrl = `/image/32/${encodeURIComponent(avatarId)}`

    const ts = new Date(msg.value.timestamp)
    let isoTs

    try {
      isoTs = ts.toISOString()
    } catch (e) {
      // Just in case it's an invalid date. :(
      debug(e)
      const receivedTs = new Date(msg.timestamp)
      isoTs = receivedTs.toISOString()
    }

    lodash.set(msg, 'value.meta.timestamp.received.iso8601', isoTs)

    const ago = Date.now() - Number(ts)
    const prettyAgo = prettyMs(ago, { compact: true })
    lodash.set(msg, 'value.meta.timestamp.received.since', prettyAgo)
    lodash.set(msg, 'value.meta.author.name', name)
    lodash.set(msg, 'value.meta.author.avatar', {
      id: avatarId,
      url: avatarUrl
    })

    if (isRoot(msg)) {
      lodash.set(msg, 'value.meta.postType', 'posted')
    } else if (isReply(msg)) {
      lodash.set(msg, 'value.meta.postType', 'replied to thread')
    } else if (isNestedReply(msg)) {
      lodash.set(msg, 'value.meta.postType', 'replied to message')
    } else {
      lodash.set(msg, 'value.meta.postType', 'published a mysterious message')
    }

    lodash.set(msg, 'value.meta.votes', voters)
    lodash.set(msg, 'value.meta.voted', voters.includes(myFeedId))

    return msg
  }))

const post = {
  fromFeed: async (feedId, customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const options = configure({ id: feedId }, customOptions)
    const source = await cooler.read(
      ssb.createUserStream,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter((msg) => typeof msg.value.content !== 'string' &&
          msg.value.content.type === 'post'),
        pull.take(maxMessages),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err)
          } else {
            resolve(transform(ssb, collectedMessages, myFeedId))
          }
        })
      )
    })

    return messages
  },
  mentionsMe: async (customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const query = [{
      $filter: {
        dest: myFeedId
      }
    }]

    const messages = await getMessages({
      myFeedId,
      customOptions,
      ssb,
      query,
      filter: (msg) => msg.value.author !== myFeedId
    })

    return messages
  },
  fromHashtag: async (hashtag, customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const query = [{
      $filter: {
        dest: `#${hashtag}`
      }
    }]

    const messages = await getMessages({ myFeedId, customOptions, ssb, query })

    return messages
  },
  likes: async ({ feed }, customOptions = {}) => {
    const ssb = await cooler.connect()

    const query = [{
      $filter: {
        value: {
          author: feed,
          content: {
            type: 'vote'
          }
        }
      }
    }]

    const options = configure({
      query,
      index: 'DTA',
      reverse: true
    }, customOptions)

    const source = await cooler.read(
      ssb.query.read, options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter((msg) => {
          return typeof msg.value.content === 'object' &&
          msg.value.author === feed &&
          typeof msg.value.content.vote === 'object' &&
          typeof msg.value.content.vote.link === 'string'
        }),
        pull.take(maxMessages),
        pullParallelMap(async (val, cb) => {
          const msg = await post.get(val.value.content.vote.link)
          cb(null, msg)
        }),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err)
          } else {
            resolve(collectedMessages)
          }
        })
      )
    })

    return messages
  },
  latest: async (customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const options = configure({
      type: 'post'
    }, customOptions)

    const source = await cooler.read(
      ssb.messagesByType,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter((message) => // avoid private messages (!)
          typeof message.value.content !== 'string'
        ),
        pull.take(maxMessages),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err)
          } else {
            resolve(transform(ssb, collectedMessages, myFeedId))
          }
        })
      )
    })

    return messages
  },
  popular: async (customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const now = new Date()
    const yesterday = Number(now) - 1000 * 60 * 60 * 24 * 1

    const options = configure({
      type: 'vote',
      gt: yesterday
    }, customOptions)

    const source = await cooler.read(
      ssb.messagesByType,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter((msg) => {
          return typeof msg.value.content === 'object' &&
          typeof msg.value.content.vote === 'object' &&
          typeof msg.value.content.vote.link === 'string'
        }),
        pull.reduce((acc, cur) => {
          const target = cur.value.content.vote.link

          const old = acc[target] || 0
          acc[target] = old + 1

          return acc
        }, {}, (err, obj) => {
          if (err) {
            return reject(err)
          }

          // HACK: Can we do this without a reduce()? I think this makes the
          // stream much slower than it needs to be. Also, we should probably
          // be indexing these rather than building the stream on refresh.

          const arr = Object.entries(obj)
          const length = arr.length

          pull(
            pull.values(arr),
            pullSort(([aKey, aVal], [bKey, bVal]) =>
              bVal - aVal
            ),
            pull.take(Math.min(length, maxMessages)),
            pull.map(([key, value]) => key),
            pullParallelMap(async (key, cb) => {
              try {
                const msg = await post.get(key)
                cb(null, msg)
              } catch (e) {
                cb(null, null)
              }
            }),
            pull.filter((message) => // avoid private messages (!)
              message &&
              typeof message.value.content !== 'string'
            ),
            pull.collect((err, collectedMessages) => {
              if (err) {
                reject(err)
              } else {
                resolve(transform(ssb, collectedMessages, myFeedId))
              }
            })
          )
        })
      )
    })

    return messages
  },
  fromThread: async (msgId, customOptions) => {
    debug('thread: %s', msgId)
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const options = configure({ id: msgId }, customOptions)
    const rawMsg = await cooler.get(ssb.get, options)
    debug('got raw message')

    const parents = []

    const getRootAncestor = (msg) => new Promise((resolve, reject) => {
      if (msg.key == null) {
        debug('something is very wrong, we used `{ meta: true }`')
        resolve(parents)
      } else {
        debug('getting root ancestor of %s', msg.key)

        if (typeof msg.value.content === 'string') {
          debug('private message')
          // Private message we can't decrypt, stop looking for parents.
          resolve(parents)
        }

        if (msg.value.content.type !== 'post') {
          debug('not a post')
          resolve(msg)
        }

        if (isNestedReply(msg)) {
          debug('fork, get the parent')
          try {
            // It's a message reply, get the parent!
            cooler.get(ssb.get, {
              id: msg.value.content.fork,
              meta: true,
              private: true
            }).then((fork) => {
              resolve(getRootAncestor(fork))
            }).catch(reject)
          } catch (e) {
            debug(e)
            resolve(msg)
          }
        } else if (isReply(msg)) {
          debug('thread reply: %s', msg.value.content.root)
          try {
            // It's a thread reply, get the parent!
            cooler.get(ssb.get, {
              id: msg.value.content.root,
              meta: true,
              private: true
            }).then((root) => {
              resolve(getRootAncestor(root))
            }).catch(reject)
          } catch (e) {
            debug(e)
            resolve(msg)
          }
        } else if (isRoot(msg)) {
          debug('got root ancestor')
          resolve(msg)
        } else {
          // type !== "post", probably
          // this should show up as JSON
          debug('got mysterious root ancestor that fails all known schemas')
          debug('%O', msg)
          resolve(msg)
        }
      }
    })

    const getReplies = (key) => new Promise((resolve, reject) => {
      const filterQuery = {
        $filter: {
          dest: key
        }
      }

      cooler.read(ssb.backlinks.read, {
        query: [filterQuery],
        index: 'DTA' // use asserted timestamps
      }).then((referenceStream) => {
        pull(
          referenceStream,
          pull.filter((msg) => {
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
            if (err) {
              reject(err)
            } else {
              resolve(messages || undefined)
            }
          })
        )
      }).catch(reject)
    })

    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat
    const flattenDeep = (arr1) => arr1.reduce(
      (acc, val) => (Array.isArray(val)
        ? acc.concat(flattenDeep(val))
        : acc.concat(val)
      ),
      []
    )

    const getDeepReplies = (key) => new Promise((resolve, reject) => {
      const oneDeeper = async (replyKey, depth) => {
        const replies = await getReplies(replyKey)
        debug('replies', replies.map((m) => m.key))

        debug('found %s replies for %s', replies.length, replyKey)

        if (replies.length === 0) {
          return replies
        }
        return Promise.all(replies.map(async (reply) => {
          const deeperReplies = await oneDeeper(reply.key, depth + 1)
          lodash.set(reply, 'value.meta.thread.depth', depth)
          lodash.set(reply, 'value.meta.thread.reply', true)
          return [reply, deeperReplies]
        }))
      }
      oneDeeper(key, 0).then((nested) => {
        const nestedReplies = [...nested]
        const deepReplies = flattenDeep(nestedReplies)
        resolve(deepReplies)
      }).catch(reject)
    })

    debug('about to get root ancestor')
    const rootAncestor = await getRootAncestor(rawMsg)
    debug('got root ancestors')
    const deepReplies = await getDeepReplies(rootAncestor.key)
    debug('got deep replies')

    const allMessages = [rootAncestor, ...deepReplies].map((message) => {
      const isThreadTarget = message.key === msgId
      lodash.set(message, 'value.meta.thread.target', isThreadTarget)
      return message
    })

    const transformed = await transform(ssb, allMessages, myFeedId)
    return transformed
  },
  get: async (msgId, customOptions) => {
    debug('get: %s', msgId)
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const options = configure({ id: msgId }, customOptions)
    const rawMsg = await cooler.get(ssb.get, options)
    debug('got raw message')

    const transformed = await transform(ssb, [rawMsg], myFeedId)
    debug('transformed: %O', transformed)
    return transformed[0]
  },
  publish: async (options) => {
    const ssb = await cooler.connect()
    const body = { type: 'post', ...options }

    debug('Published: %O', body)
    return cooler.get(ssb.publish, body)
  },
  reply: async ({ parent, message }) => {
    message.root = parent.key
    message.fork = lodash.get(parent, 'value.content.root')
    message.branch = await post.branch({ root: parent.key })
    message.type = 'post' // redundant but used for validation

    if (isNestedReply(message) !== true) {
      const messageString = JSON.stringify(message, null, 2)
      throw new Error(`message should be valid reply: ${messageString}`)
    }

    return post.publish(message)
  },
  replyAll: async ({ parent, message }) => {
    const fork = parent.key
    const root = lodash.get(parent, 'value.content.root', parent.key)
    message.root = fork || root
    message.branch = await post.branch({ root: parent.key })
    message.type = 'post' // redundant but used for validation

    if (isReply(message) !== true) {
      const messageString = JSON.stringify(message, null, 2)
      throw new Error(`message should be valid replyAll: ${messageString}`)
    }

    return post.publish(message)
  },
  branch: async ({ root }) => {
    const ssb = await cooler.connect()
    const keys = await cooler.get(ssb.tangle.branch, root)

    return keys
  },
  inbox: async (customOptions = {}) => {
    const ssb = await cooler.connect()

    const whoami = await cooler.get(ssb.whoami)
    const myFeedId = whoami.id

    const options = configure({
      type: 'post'
    }, customOptions)

    const source = await cooler.read(
      ssb.messagesByType,
      options
    )

    const messages = await new Promise((resolve, reject) => {
      pull(
        source,
        pull.filter((message) => // avoid private messages (!)
          typeof message.value.content !== 'string' &&
          lodash.get(message, 'value.meta.private')
        ),
        pull.unique((message) => {
          const { root } = message.value.content
          if (root == null) {
            return message.key
          } else {
            return root
          }
        }),
        pull.take(maxMessages),
        pull.collect((err, collectedMessages) => {
          if (err) {
            reject(err)
          } else {
            resolve(transform(ssb, collectedMessages, myFeedId))
          }
        })
      )
    })

    return messages
  }
}

module.exports = post
