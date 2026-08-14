Pod::Spec.new do |s|
  s.name         = "YaverSpeech"
  s.version      = "1.0.0"
  s.summary      = "STT/TTS native bridge for Yaver tvOS"
  s.homepage     = "https://yaver.io"
  s.license      = { :type => "MIT" }
  s.author       = { "Yaver" => "hi@yaver.io" }
  s.platforms    = { :ios => "15.1", :tvos => "15.1" }
  s.source       = { :git => "", :tag => s.version.to_s }
  s.source_files = "**/*.{swift}"
  s.swift_version = "5.0"
  s.dependency "React-Core"
  s.frameworks   = "AVFoundation"
end
