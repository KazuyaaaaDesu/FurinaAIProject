
using System;
using System.Windows;
using System.Windows.Controls;

namespace Fufuu.Wpf.Pet;

public partial class PetPreferencesWindow : Window
{
    private readonly DesktopPetWindow _petWindow;
    private readonly DesktopStageSettings _original;

    public PetPreferencesWindow(DesktopPetWindow petWindow)
    {
        _petWindow = petWindow;
        _original = petWindow.Settings;

        InitializeComponent();

        DisplayModeCombo.SelectedValue = _original.DisplayMode;
        CharacterScaleSlider.Value = _original.CharacterScale;
        CharacterXSlider.Value = _original.CharacterX;
        CharacterYSlider.Value = _original.CharacterY;
        WalkingSpeedSlider.Value = _original.WalkingSpeed;

        RoamingCheck.IsChecked = _original.RoamingEnabled;
        AlwaysOnTopCheck.IsChecked = _original.AlwaysOnTop;
        EdgeHideCheck.IsChecked = _original.EdgeHideEnabled;
        ClickThroughCheck.IsChecked = _original.ClickThroughEnabled;
        MouseAvoidanceCheck.IsChecked = _original.MouseAvoidanceEnabled;

        UpdateValueLabels();
    }

    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var selectedMode = DisplayModeCombo.SelectedValue?.ToString();

            if (string.IsNullOrWhiteSpace(selectedMode))
            {
                System.Windows.MessageBox.Show(
                    this,
                    "Please select a display mode.",
                    "Pet Preferences",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);

                return;
            }

            var next = _original with
            {
                DisplayMode = selectedMode,
                CharacterScale = CharacterScaleSlider.Value,
                CharacterX = CharacterXSlider.Value,
                CharacterY = CharacterYSlider.Value,
                WalkingSpeed = WalkingSpeedSlider.Value,
                RoamingEnabled = RoamingCheck.IsChecked ?? false,
                AlwaysOnTop = AlwaysOnTopCheck.IsChecked ?? false,
                EdgeHideEnabled = EdgeHideCheck.IsChecked ?? false,
                ClickThroughEnabled = ClickThroughCheck.IsChecked ?? false,
                MouseAvoidanceEnabled = MouseAvoidanceCheck.IsChecked ?? false
            };

            if (!next.IsValid())
            {
                System.Windows.MessageBox.Show(
                    this,
                    "Please correct the preference values and try again.",
                    "Pet Preferences",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);

                return;
            }

            _petWindow.ApplySettings(next);
            Close();
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(
                this,
                $"Could not apply pet preferences:\n{ex.Message}",
                "Pet Preferences",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private void CharacterScaleSlider_ValueChanged(
        object sender,
        RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateValueLabels();
    }

    private void CharacterXSlider_ValueChanged(
        object sender,
        RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateValueLabels();
    }

    private void CharacterYSlider_ValueChanged(
        object sender,
        RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateValueLabels();
    }

    private void WalkingSpeedSlider_ValueChanged(
        object sender,
        RoutedPropertyChangedEventArgs<double> e)
    {
        UpdateValueLabels();
    }

    private void UpdateValueLabels()
    {
        if (CharacterScaleValue is null ||
            CharacterXValue is null ||
            CharacterYValue is null ||
            WalkingSpeedValue is null)
        {
            return;
        }

        CharacterScaleValue.Text =
            $"{CharacterScaleSlider.Value:0.00}×";

        CharacterXValue.Text =
            $"{CharacterXSlider.Value:+0.00;-0.00}";

        CharacterYValue.Text =
            $"{CharacterYSlider.Value:+0.00;-0.00}";

        WalkingSpeedValue.Text =
            $"{WalkingSpeedSlider.Value:0.00}";
    }
}
