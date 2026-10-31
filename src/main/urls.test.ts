import { describe, expect, it } from 'vitest'
import { isConsoleUrl, isSignInUrl, windowOpenAction, consoleRegion } from './urls'

describe('windowOpenAction', () => {
  it('keeps the URL-less auth-flow open as a real popup', () => {
    expect(windowOpenAction('')).toBe('popup')
    expect(windowOpenAction('about:blank')).toBe('popup')
  })

  it('opens Amazon / AWS https pages as tabs', () => {
    expect(windowOpenAction('https://us-east-1.console.aws.amazon.com/lambda/home')).toBe('tab')
    expect(windowOpenAction('https://docs.aws.amazon.com/lambda/')).toBe('tab')
    expect(windowOpenAction('https://foo.awsapps.com/start')).toBe('tab')
  })

  it('sends other web URLs to the system browser', () => {
    expect(windowOpenAction('https://github.com/x')).toBe('external')
    // Anyone can host pages on amazonaws.com, and http is never in-app.
    expect(windowOpenAction('https://evil.s3.amazonaws.com/x')).toBe('external')
    expect(windowOpenAction('http://console.aws.amazon.com/')).toBe('external')
    expect(windowOpenAction('https://amazon.com.evil.com/')).toBe('external')
  })

  it('drops non-web schemes', () => {
    expect(windowOpenAction('file:///etc/passwd')).toBe('deny')
    expect(windowOpenAction('smb://host/share')).toBe('deny')
    expect(windowOpenAction('javascript:alert(1)')).toBe('deny')
  })
})

describe('session URLs', () => {
  it('tells a sign-in redirect from our own federation login', () => {
    expect(isSignInUrl('https://signin.aws.amazon.com/signin?redirect_uri=x')).toBe(true)
    expect(isSignInUrl('https://us-east-1.signin.aws.amazon.com/oauth?x=1')).toBe(true)
    expect(isSignInUrl('https://signin.aws.amazon.com/federation?Action=login')).toBe(false)
    expect(isSignInUrl('https://signin.aws.amazon.com.evil.com/signin')).toBe(false)
  })

  it('accepts only https console URLs as a destination', () => {
    expect(isConsoleUrl('https://eu-west-1.console.aws.amazon.com/s3/buckets')).toBe(true)
    expect(isConsoleUrl('https://console.aws.amazon.com/iam/home')).toBe(true)
    expect(isConsoleUrl('http://console.aws.amazon.com/iam/home')).toBe(false)
    expect(isConsoleUrl('https://signin.aws.amazon.com/')).toBe(false)
  })
})

describe('consoleRegion', () => {
  it('reads the region of a console page from its query or host', () => {
    expect(consoleRegion('https://ap-northeast-1.console.aws.amazon.com/ec2/home?region=ap-northeast-1#Instances:')).toBe('ap-northeast-1')
    expect(consoleRegion('https://eu-west-1.console.aws.amazon.com/s3/buckets')).toBe('eu-west-1')
    expect(consoleRegion('https://console.aws.amazon.com/iam/home')).toBeUndefined()
    expect(consoleRegion('https://us-east-1.console.aws.amazon.com/x?region=evil;rm')).toBeUndefined()
    expect(consoleRegion('https://evil.example/?region=us-east-1')).toBeUndefined()
  })
})
