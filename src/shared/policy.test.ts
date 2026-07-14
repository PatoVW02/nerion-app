import { describe, expect, it } from 'vitest'
import { isCleanable, isContentOnlyProtectedRoot, isCriticalPath, resolveQuickFolderPath } from './policy'

describe('deletion path policy', () => {
  it('blocks system roots but allows content-only cleanup of user folders', () => {
    const home = '/Users/pat'
    expect(isCriticalPath('/System/Library', 'macos', home)).toBe(true)
    expect(isCriticalPath(`${home}/Downloads`, 'macos', home)).toBe(true)
    expect(isContentOnlyProtectedRoot(`${home}/Downloads`, 'macos', home)).toBe(true)
    expect(isContentOnlyProtectedRoot('/Users/other/Downloads', 'macos', home)).toBe(false)
    expect(isContentOnlyProtectedRoot('/custom/home/Downloads', 'macos', '/custom/home')).toBe(true)
    expect(isContentOnlyProtectedRoot(`${home}/Library/Keychains`, 'macos', home)).toBe(false)
    expect(isCriticalPath(`${home}/Library/Containers/com.example.uninstalled`, 'macos', home)).toBe(false)
    expect(isCriticalPath('/Library/Application Support/Example Vendor', 'macos', home)).toBe(false)
    expect(isCriticalPath('/Library/Application Support/Example Vendor/Nested', 'macos', home)).toBe(true)
    expect(isCriticalPath('/tmp/../System/Library', 'macos', home)).toBe(true)
    expect(isCriticalPath('../System/Library', 'macos', home)).toBe(true)
    expect(isCriticalPath('/custom/home/Library/Keychains/secret', 'macos', '/custom/home')).toBe(true)
  })

  it('uses Windows-native protected path rules', () => {
    const home = 'C:\\Users\\Pat'
    expect(isCriticalPath('C:\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isContentOnlyProtectedRoot('C:\\Users\\Pat\\Downloads', 'windows', home)).toBe(true)
    expect(isContentOnlyProtectedRoot('C:\\Users\\Pat\\AppData\\Local\\Temp', 'windows', home)).toBe(true)
    expect(isCriticalPath('C:\\Users\\Pat\\AppData\\Local\\Temp\\Nerion\\file.bin', 'windows', home)).toBe(false)
    expect(isCriticalPath('C:\\Users\\Pat\\Projects\\Nerion', 'windows', home)).toBe(false)
    expect(isCriticalPath('D:\\', 'windows', home)).toBe(true)
    expect(isCriticalPath('D:\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('\\\\server\\share', 'windows', home)).toBe(true)
    expect(isContentOnlyProtectedRoot('D:\\$Recycle.Bin', 'windows', home)).toBe(true)
    expect(isCriticalPath('D:\\Temp\\..\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('\\tmp\\nerion-delete-fixture', 'windows', home)).toBe(true)
    expect(isCriticalPath('\\\\?\\C:\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('\\\\.\\C:\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('\\\\localhost\\C$\\Windows\\System32', 'windows', home)).toBe(true)
    expect(isCriticalPath('C:\\Users\\Pat\\file.txt:stream', 'windows', home)).toBe(true)
    expect(resolveQuickFolderPath('\\\\server\\Share\\Folder', home, 'windows')).toBe('\\\\server\\Share\\Folder')
  })

  it('only promotes cache-like names inside known cleanup roots', () => {
    const macHome = '/Users/pat'
    const winHome = 'C:\\Users\\Pat'
    const entry = (name: string, path: string) => ({ name, path, isDir: true, sizeKB: 1 })

    expect(isCleanable(entry('Logs', `${macHome}/Documents/Logs`), 'macos', macHome)).toBe(false)
    expect(isCleanable(entry('tmp', `${macHome}/Desktop/project/tmp`), 'macos', macHome)).toBe(false)
    expect(isCleanable(entry('DerivedData', `${macHome}/Library/Developer/Xcode/DerivedData`), 'macos', macHome)).toBe(true)
    expect(isCleanable(entry('Logs', `${macHome}/Library/Logs`), 'macos', macHome)).toBe(true)
    expect(isCleanable(entry('Temp', `${winHome}\\Desktop\\Temp`), 'windows', winHome)).toBe(false)
    expect(isCleanable(entry('Temp', `${winHome}\\AppData\\Local\\Temp`), 'windows', winHome)).toBe(true)
  })
})
